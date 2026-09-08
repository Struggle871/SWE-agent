import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../../src/core/agent-session.js";
import { CompactionFailure } from "../../src/core/context/compaction-manager.js";
import { createCallId, createSessionId } from "../../src/protocol/ids.js";
import type {
  ModelCapabilities, ModelEvent, ModelRequest, ModelTransport, RemoteCompactionRequest, RemoteCompactionResult,
} from "../../src/protocol/model-events.js";
import { readRollout } from "../../src/persistence/rollout-reader.js";
import { RolloutWriter, type AppendContext } from "../../src/persistence/rollout-writer.js";
import type { TranscriptEnvelope, TranscriptKind, TranscriptPayload } from "../../src/persistence/rollout-schema.js";
import type { AgentContext } from "../../src/types.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";

class ScriptedTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  readonly compactRequests: RemoteCompactionRequest[] = [];
  streamCalls = 0;
  compactCalls = 0;

  constructor(
    private readonly streamScript?: (request: ModelRequest, signal: AbortSignal, call: number) => AsyncIterable<ModelEvent>,
    private readonly compactScript?: (request: RemoteCompactionRequest, signal: AbortSignal, call: number) => Promise<RemoteCompactionResult>,
    private readonly caps: ModelCapabilities = {
      nativeToolCalls: true, streamingText: true, usage: true, reasoningDeltas: false,
    },
  ) {}

  capabilities(): ModelCapabilities { return this.caps; }
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.streamCalls += 1;
    return this.streamScript?.(request, signal, this.streamCalls) ?? finalResponse(request);
  }
  compact(request: RemoteCompactionRequest, signal: AbortSignal): Promise<RemoteCompactionResult> {
    this.compactRequests.push(request);
    this.compactCalls += 1;
    if (!this.compactScript) return Promise.reject(new Error("unexpected remote compact"));
    return this.compactScript(request, signal, this.compactCalls);
  }
}

test("manual local checkpoint resumes and forks without resummarizing", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const transcriptRoot = path.join(ctx.workspaceRoot, "state");
  const transport = new ScriptedTransport((request) => {
    const compact = request.messages.at(-1)?.content.includes("handoff checkpoint");
    return compact ? textResponse(request, "summary: preserve requirements and next steps") : finalResponse(request);
  });
  useTransport(ctx, transport);
  ctx.config.compaction = { backend: "local", autoCompactTokenLimit: 7_500 };
  const session = new AgentSession(ctx, undefined, { transcriptRoot });
  await session.run("first request");
  const compacted = await session.compact();
  assert.equal(compacted.checkpoint.implementation, "local_responses");
  assert.equal(compacted.checkpoint.window.windowNumber, 1);
  assert.match(compacted.checkpoint.summary ?? "", /preserve requirements/);
  const compactedAgain = await session.compact();
  assert.equal(compactedAgain.checkpoint.window.windowNumber, 2);
  assert.equal(compactedAgain.checkpoint.replacementHistory.filter((item) => item.metadata.kind === "context_injection").length, 1);
  const parentId = session.sessionId;
  const expected = compactedAgain.checkpoint.replacementHistory.map((item) => item.message);
  await session.close();
  const summaryCalls = transport.requests.filter((request) => request.messages.at(-1)?.content.includes("handoff checkpoint")).length;

  const resumed = await AgentSession.resume(ctx, parentId, undefined, { transcriptRoot });
  assert.deepEqual(resumed.recovery?.history, expected);
  assert.equal(transport.requests.filter((request) => request.messages.at(-1)?.content.includes("handoff checkpoint")).length, summaryCalls);
  await resumed.close();

  const fork = await AgentSession.fork(ctx, parentId, {}, undefined, { transcriptRoot });
  assert.deepEqual(fork.recovery?.history, expected);
  assert.equal(fork.recovery?.window.windowNumber, 0);
  assert.equal(transport.requests.filter((request) => request.messages.at(-1)?.content.includes("handoff checkpoint")).length, summaryCalls);
  assert.equal((await fork.compact()).checkpoint.window.windowNumber, 1);
  const forkId = fork.sessionId;
  await fork.close();
  const resumedFork = await AgentSession.resume(ctx, forkId, undefined, { transcriptRoot });
  assert.equal(resumedFork.recovery?.window.windowNumber, 1);
  await resumedFork.close();
});

test("remote compaction uses the provider capability boundary and installs annotated replacement", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const transport = new ScriptedTransport(
    undefined,
    async () => ({
      replacement: [{ role: "user", content: "remote checkpoint" }],
      metadata: [{ responseId: "response-1" }],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    }),
    { nativeToolCalls: true, streamingText: true, usage: true, reasoningDeltas: false, remoteCompaction: "v2" },
  );
  useTransport(ctx, transport);
  ctx.config.compaction = { backend: "auto", autoCompactTokenLimit: 7_500 };
  const session = new AgentSession(ctx, undefined, { transcriptRoot: path.join(ctx.workspaceRoot, "state") });
  await session.run("seed");
  const result = await session.compact();
  assert.equal(result.checkpoint.implementation, "remote_compaction_v2");
  assert.equal(transport.compactCalls, 1);
  const request = transport.compactRequests[0];
  assert.equal(request.model, ctx.config.model.model);
  assert.equal(request.parallelToolCalls, false);
  assert.ok(request.tools.length > 0);
  assert.equal(request.input.some((message) => message.content.includes("<environment_context>")), false);
  assert.ok(result.checkpoint.replacementHistory.some((item) =>
    item.metadata.kind === "remote_compaction" && item.metadata.provider?.responseId === "response-1"));
  await session.close();
});

test("automatic pre-turn and mid-turn compaction have distinct phases and do not repeat tools", async (t) => {
  const preCtx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(preCtx));
  preCtx.config.compaction = { backend: "new_context", autoCompactTokenLimit: 1 };
  const preSession = new AgentSession(preCtx, undefined, { transcriptRoot: path.join(preCtx.workspaceRoot, "state") });
  await preSession.run("pre");
  const preRecords = (await readRollout(preSession.transcriptPath)).records;
  assert.ok(preRecords.some((record) => record.kind === "compact_checkpoint" && (record.payload as { phase?: string }).phase === "pre_turn"));
  await preSession.close();

  const midCtx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(midCtx));
  midCtx.config.maxContextTokens = 100_000;
  midCtx.config.maxOutputTokens = 1_000;
  midCtx.config.compaction = { backend: "new_context", autoCompactTokenLimit: 8_000, fallbackBufferTokens: 100 };
  let toolRuns = 0;
  midCtx.registry.register({
    name: "large_result", description: "large", isReadOnly: true,
    parameters: { type: "object", properties: {} },
    async execute() { toolRuns += 1; return { toolName: "large_result", output: "x".repeat(40_000) }; },
  });
  const transport = new ScriptedTransport((request, _signal, call) => call === 1 ? toolResponse(request, "large_result") : finalResponse(request));
  useTransport(midCtx, transport);
  const midSession = new AgentSession(midCtx, undefined, { transcriptRoot: path.join(midCtx.workspaceRoot, "state") });
  await midSession.run("run the tool");
  const midRecords = (await readRollout(midSession.transcriptPath)).records;
  assert.equal(toolRuns, 1);
  assert.ok(midRecords.some((record) => record.kind === "compact_checkpoint" && (record.payload as { phase?: string }).phase === "mid_turn"));
  await midSession.close();
});

test("a comp-hash change forces pre-turn rollover even below the token threshold", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  ctx.config.maxContextTokens = 100_000;
  ctx.config.compaction = { backend: "new_context", autoCompactTokenLimit: 90_000 };
  const session = new AgentSession(ctx, undefined, { transcriptRoot: path.join(ctx.workspaceRoot, "state") });
  await session.run("first");
  ctx.agentMemories = "new project instruction";
  await session.run("second");
  const records = (await readRollout(session.transcriptPath)).records;
  assert.ok(records.some((record) =>
    record.kind === "compact_checkpoint" && (record.payload as { reason?: string }).reason === "comp_hash_changed"));
  await session.close();
});

test("switching to a smaller model context triggers model-downshift compaction", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  ctx.config.maxContextTokens = 100_000;
  ctx.config.compaction = { backend: "new_context", autoCompactTokenLimit: 90_000 };
  const session = new AgentSession(ctx, undefined, { transcriptRoot: path.join(ctx.workspaceRoot, "state") });
  await session.run("large-model turn");
  ctx.config.model.model = "smaller-model";
  ctx.config.maxContextTokens = 50_000;
  ctx.config.compaction.autoCompactTokenLimit = 45_000;
  await session.run("after downshift");
  const records = (await readRollout(session.transcriptPath)).records;
  assert.ok(records.some((record) =>
    record.kind === "compact_checkpoint" && (record.payload as { reason?: string }).reason === "model_downshift"));
  await session.close();
});

test("PreCompact stops before a checkpoint while PostCompact keeps the committed checkpoint", async (t) => {
  const preCtx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(preCtx));
  preCtx.config.compaction = { backend: "new_context" };
  const pre = new AgentSession(preCtx, undefined, {
    transcriptRoot: path.join(preCtx.workspaceRoot, "state"),
    compactionHooks: { preCompact: () => "stop" },
  });
  await assert.rejects(pre.compact(), (error: unknown) => error instanceof CompactionFailure && error.code === "compaction_interrupted");
  assert.equal((await readRollout(pre.transcriptPath)).records.some((record) => record.kind === "compact_checkpoint"), false);
  await pre.close();

  const postCtx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(postCtx));
  postCtx.config.compaction = { backend: "new_context" };
  const post = new AgentSession(postCtx, undefined, {
    transcriptRoot: path.join(postCtx.workspaceRoot, "state"),
    compactionHooks: { postCompact: () => "stop" },
  });
  const result = await post.compact();
  assert.equal(result.postHookStopped, true);
  assert.equal((await readRollout(post.transcriptPath)).records.some((record) => record.kind === "compact_checkpoint"), true);
  await post.close();
});

test("local compaction timeout is retried and remains an uncommitted failure", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  let calls = 0;
  const transport = new ScriptedTransport(async function* (_request, signal) {
    calls += 1;
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
  });
  useTransport(ctx, transport);
  ctx.config.compaction = { backend: "local", timeoutMs: 10, maxRetries: 1 };
  const session = new AgentSession(ctx, undefined, { transcriptRoot: path.join(ctx.workspaceRoot, "state") });
  await assert.rejects(session.compact(), (error: unknown) => error instanceof CompactionFailure && error.code === "compaction_timeout");
  assert.equal(calls, 2);
  assert.equal((await readRollout(session.transcriptPath)).records.some((record) => record.kind === "compact_checkpoint"), false);
  await session.close();
});

test("local compaction retries transient failures but an external cancellation never commits", async (t) => {
  const retryCtx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(retryCtx));
  const retryTransport = new ScriptedTransport((request, _signal, call) => {
    if (call < 3) throw new Error("temporary provider failure");
    return textResponse(request, "retry succeeded");
  });
  useTransport(retryCtx, retryTransport);
  retryCtx.config.compaction = { backend: "local", maxRetries: 2, timeoutMs: 1_000 };
  const retried = new AgentSession(retryCtx, undefined, { transcriptRoot: path.join(retryCtx.workspaceRoot, "state") });
  assert.match((await retried.compact()).checkpoint.summary ?? "", /retry succeeded/);
  assert.equal(retryTransport.streamCalls, 3);
  await retried.close();

  const cancelCtx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(cancelCtx));
  let started = false;
  const cancelTransport = new ScriptedTransport(async function* (_request, signal) {
    started = true;
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
  });
  useTransport(cancelCtx, cancelTransport);
  cancelCtx.config.compaction = { backend: "local", maxRetries: 3, timeoutMs: 5_000 };
  const cancelled = new AgentSession(cancelCtx, undefined, { transcriptRoot: path.join(cancelCtx.workspaceRoot, "state") });
  const controller = new AbortController();
  const running = cancelled.compact({ signal: controller.signal });
  while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort(new Error("cancel compact"));
  await assert.rejects(running, (error: unknown) => error instanceof CompactionFailure && error.code === "compaction_interrupted");
  assert.equal(cancelTransport.streamCalls, 1);
  assert.equal((await readRollout(cancelled.transcriptPath)).records.some((record) => record.kind === "compact_checkpoint"), false);
  await cancelled.close();

  const shutdownCtx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(shutdownCtx));
  let shutdownStarted = false;
  const shutdownTransport = new ScriptedTransport(async function* (_request, signal) {
    shutdownStarted = true;
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
  });
  useTransport(shutdownCtx, shutdownTransport);
  shutdownCtx.config.compaction = { backend: "local", timeoutMs: 5_000 };
  const shutdownSession = new AgentSession(shutdownCtx, undefined, { transcriptRoot: path.join(shutdownCtx.workspaceRoot, "state") });
  const shuttingDown = shutdownSession.compact();
  while (!shutdownStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  shutdownSession.shutdown("shutdown compact");
  await assert.rejects(shuttingDown, (error: unknown) =>
    error instanceof CompactionFailure && error.code === "compaction_interrupted");
  await shutdownSession.close();
});

test("remote context overflow trims complete input groups before retrying", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const inputSizes: number[] = [];
  const transport = new ScriptedTransport(
    undefined,
    async (request, _signal, call) => {
      inputSizes.push(request.input.length);
      if (call === 1) throw new Error("context length exceeded");
      return { replacement: [{ role: "user", content: "trimmed remote checkpoint" }] };
    },
    { nativeToolCalls: true, streamingText: true, usage: true, reasoningDeltas: false, remoteCompaction: "v1" },
  );
  useTransport(ctx, transport);
  ctx.config.compaction = { backend: "remote", maxRetries: 2, autoCompactTokenLimit: 7_500 };
  const session = new AgentSession(ctx, undefined, { transcriptRoot: path.join(ctx.workspaceRoot, "state") });
  await session.run("one");
  await session.run("two");
  await session.compact();
  assert.equal(inputSizes.length, 2);
  assert.ok(inputSizes[1] < inputSizes[0]);
  await session.close();
});

test("invalid remote replacement is rejected before live installation", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const transport = new ScriptedTransport(undefined, async () => ({
    replacement: [{ role: "user", content: "x".repeat(1_000) }],
  }));
  useTransport(ctx, transport);
  ctx.config.compaction = { backend: "remote", maxItemBytes: 500 };
  const session = new AgentSession(ctx, undefined, { transcriptRoot: path.join(ctx.workspaceRoot, "state") });
  await assert.rejects(session.compact(), (error: unknown) =>
    error instanceof CompactionFailure && error.code === "compaction_invalid_replacement");
  assert.equal((await readRollout(session.transcriptPath)).records.some((record) => record.kind === "compact_checkpoint"), false);
  await session.close();
});

test("checkpoint append failure preserves old history; baseline failure preserves the new checkpoint", async (t) => {
  const firstCtx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(firstCtx));
  firstCtx.config.compaction = { backend: "new_context", autoCompactTokenLimit: 7_500 };
  const firstRoot = path.join(firstCtx.workspaceRoot, "state");
  const checkpointId = createSessionId();
  const checkpointWriter = new FaultWriter(path.join(firstRoot, "transcripts", `${checkpointId}.jsonl`), checkpointId, "compact_checkpoint");
  const first = new AgentSession(firstCtx, undefined, { transcriptRoot: firstRoot, sessionId: checkpointWriter.sessionId, writer: checkpointWriter });
  await first.run("preserved");
  const before = (await readRollout(first.transcriptPath)).records.filter((record) => record.kind === "message").length;
  checkpointWriter.enabled = true;
  await assert.rejects(first.compact(), (error: unknown) =>
    error instanceof CompactionFailure && error.code === "compaction_checkpoint_write_failed" && !error.committed);
  await first.run("still works");
  const after = (await readRollout(first.transcriptPath)).records.filter((record) => record.kind === "message").length;
  assert.ok(after > before);
  await first.close();

  const secondCtx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(secondCtx));
  secondCtx.config.compaction = { backend: "new_context", autoCompactTokenLimit: 7_500 };
  const secondRoot = path.join(secondCtx.workspaceRoot, "state");
  const baselineId = createSessionId();
  const baselineWriter = new FaultWriter(path.join(secondRoot, "transcripts", `${baselineId}.jsonl`), baselineId, "world_state");
  const second = new AgentSession(secondCtx, undefined, { transcriptRoot: secondRoot, sessionId: baselineWriter.sessionId, writer: baselineWriter });
  await second.run("seed");
  baselineWriter.enabled = true;
  await assert.rejects(second.compact(), (error: unknown) =>
    error instanceof CompactionFailure && error.code === "compaction_baseline_write_failed" && error.committed);
  const secondId = second.sessionId;
  assert.equal((await readRollout(second.transcriptPath)).records.some((record) => record.kind === "compact_checkpoint"), true);
  await second.close();
  const resumed = await AgentSession.resume(secondCtx, secondId, undefined, { transcriptRoot: secondRoot });
  assert.equal(resumed.recovery?.window.windowNumber, 1);
  assert.equal(resumed.recovery?.referenceContext, undefined);
  await resumed.close();
});

test("rollback across a checkpoint replays the surviving turn segment without summarizing", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  ctx.config.compaction = { backend: "new_context", autoCompactTokenLimit: 7_500 };
  const session = new AgentSession(ctx, undefined, { transcriptRoot: path.join(ctx.workspaceRoot, "state") });
  await session.run("keep");
  const before = (await readRollout(session.transcriptPath)).records;
  const boundary = [...before].reverse().find((record) => record.kind === "turn_completed")!.ordinal;
  await session.compact();
  await session.run("discard");
  const state = await session.rollback(boundary, "test");
  assert.deepEqual(state.history.filter((message) => message.role === "user").map((message) => message.content), ["keep"]);
  assert.equal(state.window.windowNumber, 0);
  await session.run("after rollback");
  await session.close();
});

test("spilled tool references survive Resume and copied Fork", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  ctx.config.maxContextTokens = 100_000;
  ctx.config.compaction = { backend: "new_context", autoCompactTokenLimit: 90_000 };
  ctx.registry.register({
    name: "huge_result", description: "huge", isReadOnly: true,
    parameters: { type: "object", properties: {} },
    async execute() { return { toolName: "huge_result", output: "z".repeat(60_000) }; },
  });
  const transport = new ScriptedTransport((request, _signal, call) => call === 1 ? toolResponse(request, "huge_result") : finalResponse(request));
  useTransport(ctx, transport);
  const transcriptRoot = path.join(ctx.workspaceRoot, "state");
  const session = new AgentSession(ctx, undefined, { transcriptRoot });
  const result = await session.run("spill");
  const toolContent = result.history.find((message) => message.role === "tool")?.content ?? "";
  const artifact = toolContent.match(/Full output saved to: (.+)/)?.[1];
  assert.ok(artifact);
  assert.equal((await fs.readFile(artifact, "utf8")).length, 60_000);
  const parentId = session.sessionId;
  await session.close();

  const resumed = await AgentSession.resume(ctx, parentId, undefined, { transcriptRoot });
  assert.ok(resumed.recovery?.history.some((message) => message.role === "tool" && message.content.includes(artifact)));
  await resumed.close();
  const fork = await AgentSession.fork(ctx, parentId, {}, undefined, { transcriptRoot });
  assert.ok(fork.recovery?.history.some((message) => message.role === "tool" && message.content.includes(artifact)));
  await fork.close();
});

class FaultWriter extends RolloutWriter {
  enabled = false;
  constructor(filePath: string, sessionId: ReturnType<typeof createSessionId>, private readonly failKind: TranscriptKind) {
    super(filePath, sessionId);
  }
  override append(kind: TranscriptKind, payload: TranscriptPayload, context: AppendContext = {}): Promise<TranscriptEnvelope> {
    if (this.enabled && kind === this.failKind) return Promise.reject(new Error(`injected ${kind} failure`));
    return super.append(kind, payload, context);
  }
}

function useTransport(ctx: AgentContext, transport: ModelTransport): void {
  ctx.model = { chat: async () => "", transport };
}

async function* finalResponse(request: ModelRequest): AsyncIterable<ModelEvent> {
  yield { type: "response_started", requestId: request.requestId };
  yield { type: "text_delta", text: "done" };
  yield { type: "usage", usage: { inputTokens: request.messages.length, outputTokens: 1, totalTokens: request.messages.length + 1 }, requestId: request.requestId };
  yield { type: "response_completed", finishReason: "stop" };
}

async function* textResponse(request: ModelRequest, text: string): AsyncIterable<ModelEvent> {
  yield { type: "response_started", requestId: request.requestId };
  yield { type: "text_delta", text };
  yield { type: "usage", usage: { inputTokens: request.messages.length, outputTokens: 2, totalTokens: request.messages.length + 2 }, requestId: request.requestId };
  yield { type: "response_completed", finishReason: "stop" };
}

async function* toolResponse(request: ModelRequest, name: string): AsyncIterable<ModelEvent> {
  const callId = createCallId();
  yield { type: "response_started", requestId: request.requestId };
  yield { type: "tool_call_started", callId, name };
  yield { type: "tool_call_completed", callId, input: {} };
  yield { type: "usage", usage: { inputTokens: request.messages.length, outputTokens: 1, totalTokens: request.messages.length + 1 }, requestId: request.requestId };
  yield { type: "response_completed", finishReason: "tool_calls" };
}
