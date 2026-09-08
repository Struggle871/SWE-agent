import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRequestId, createWindowId } from "../../src/protocol/ids.js";
import { ContextWindowState } from "../../src/core/context/context-window.js";
import { envelope, normalizeCallPairs, retainLocalUserHistory } from "../../src/core/context/compaction-history.js";
import { applyWorldState, worldStateDiff } from "../../src/core/context/world-state.js";
import { ToolResultStorage } from "../../src/core/context/tool-result-storage.js";
import { ContextManager } from "../../src/core/context/context-manager.js";
import { CompactionFailure, CompactionManager } from "../../src/core/context/compaction-manager.js";
import { estimateModelMessageTokens, requestFingerprint } from "../../src/core/context/token-accounting.js";
import { RolloutWriter } from "../../src/persistence/rollout-writer.js";
import { createSessionId } from "../../src/protocol/ids.js";
import { makeContext, makeWorkspace, cleanupContext } from "../helpers.js";

test("window ids are UUIDv7 and lineage only advances from its current parent", () => {
  const id = createWindowId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const state = new ContextWindowState();
  const before = state.snapshot();
  const next = state.next();
  assert.equal(next.windowNumber, 1);
  assert.equal(next.firstWindowId, before.firstWindowId);
  assert.equal(next.previousWindowId, before.windowId);
  state.commit(next);
  assert.throws(() => state.commit(next), /lineage/);
  assert.equal(state.claimAttempt("context_limit", "mid_turn"), true);
  assert.equal(state.claimAttempt("context_limit", "mid_turn"), false);
});

test("automatic new-context compaction rejects a replacement that makes no token progress", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  ctx.config.maxContextTokens = 100_000;
  ctx.config.compaction = { backend: "new_context", autoCompactTokenLimit: 1 };
  const context = new ContextManager();
  context.recordPersisted(envelope({ role: "user", content: "small" }, { kind: "conversation" }));
  const writer = new RolloutWriter(path.join(ctx.workspaceRoot, "no-progress.jsonl"), createSessionId());
  t.after(() => writer.shutdown());
  const manager = new CompactionManager({
    ctx,
    context,
    persist: (kind, payload, appendContext) => writer.append(kind, payload, appendContext),
  });
  await assert.rejects(manager.compact({
    trigger: "auto",
    reason: "context_limit",
    phase: "mid_turn",
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof CompactionFailure && error.code === "compaction_no_progress");
  assert.equal(context.window.snapshot().windowNumber, 0);
});

test("token status distinguishes total and body-after-prefix scopes and reserves output", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  ctx.config.maxContextTokens = 1_000;
  ctx.config.maxOutputTokens = 100;
  ctx.config.compaction = { autoCompactTokenLimit: 500, fallbackBufferTokens: 50, limitScope: "body_after_prefix" };
  const state = new ContextWindowState(undefined, 300);
  const body = state.tokenStatus(700, ctx.config);
  assert.equal(body.scopeTokens, 400);
  assert.equal(body.autoCompactLimitReached, false);
  assert.equal(body.hardLimitReached, false);
  ctx.config.compaction.limitScope = "total";
  const total = state.tokenStatus(700, ctx.config);
  assert.equal(total.scopeTokens, 700);
  assert.equal(total.autoCompactLimitReached, true);
  assert.equal(state.tokenStatus(860, ctx.config).hardLimitReached, true);
});

test("compaction token status adds persisted and pending message estimates to an observed usage anchor", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  ctx.config.maxContextTokens = 100_000;
  ctx.config.maxOutputTokens = 1_000;
  ctx.config.compaction = { autoCompactTokenLimit: 90_000 };
  const context = new ContextManager();
  const tools = ctx.registry.visibleSpecs().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  const anchorFingerprint = requestFingerprint({
    messages: [],
    tools,
    maxOutputTokens: ctx.config.maxOutputTokens,
    model: ctx.config.model.model,
  });
  const requestId = createRequestId();
  const anchorMessage = {
    role: "assistant" as const,
    content: "observed response",
    requestId,
    usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
  };
  context.recordPersisted(context.prepareMessage(anchorMessage, {
    usageAnchor: context.usageAnchor(requestId, context.historyVersion(), anchorFingerprint, true),
  }));
  const manager = new CompactionManager({ ctx, context, persist: async () => { throw new Error("not used"); } });

  const exact = manager.tokenStatus({});
  assert.equal(exact.estimatedInputTokens, 100);
  assert.equal(exact.estimated, false);

  const persistedTail = { role: "tool" as const, content: "persisted tool output", name: "read_file" };
  context.recordPersisted(context.prepareMessage(persistedTail));
  const pending = { role: "user" as const, content: "pending input" };
  const hybrid = manager.tokenStatus({ pendingMessages: [pending] });
  assert.equal(
    hybrid.estimatedInputTokens,
    100 + estimateModelMessageTokens(persistedTail) + estimateModelMessageTokens(pending),
  );
  assert.equal(hybrid.estimated, true);
});

test("world state diff applies as a merge patch and preserves the advertised fingerprint", () => {
  const first = { full: true, state: { a: 1, remove: true }, fingerprint: "one" };
  const second = { full: true, state: { a: 2, add: "x" }, fingerprint: "two" };
  const diff = worldStateDiff(first, second, false);
  assert.deepEqual(diff, { full: false, state: { a: 2, remove: null, add: "x" }, fingerprint: "two" });
  assert.deepEqual(applyWorldState(first, diff!), second);
  assert.equal(worldStateDiff(second, second, false), undefined);
});

test("history normalization removes orphaned calls and outputs while retaining recent users", () => {
  const pairedCall = envelope({
    role: "assistant", content: "", toolCalls: [{ callId: "paired" as never, name: "read", input: {} }],
  }, { kind: "conversation" });
  const pairedOutput = envelope({ role: "tool", content: "ok", toolCallId: "paired" as never }, { kind: "conversation" });
  const orphanCall = envelope({
    role: "assistant", content: "", toolCalls: [{ callId: "orphan" as never, name: "read", input: {} }],
  }, { kind: "conversation" });
  const orphanOutput = envelope({ role: "tool", content: "bad", toolCallId: "missing" as never }, { kind: "conversation" });
  assert.deepEqual(normalizeCallPairs([pairedCall, pairedOutput, orphanCall, orphanOutput]).map((item) => item.id), [
    pairedCall.id, pairedOutput.id,
  ]);
  const users = [
    envelope({ role: "user", content: "old" }, { kind: "conversation" }),
    envelope({ role: "user", content: "recent" }, { kind: "conversation" }),
  ];
  assert.deepEqual(retainLocalUserHistory(users, 10).map((item) => item.message.content), ["recent"]);
});

test("tool result spill is content addressed, bounded, and stable for duplicate content", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = new ToolResultStorage(path.join(root, "session-a"), 4, 3);
  const first = await storage.store("read_file", "call/1", "abcdefgh");
  const second = await storage.store("read_file", "call/1", "abcdefgh");
  assert.equal(first.persisted, true);
  assert.equal(first.filePath, second.filePath);
  assert.match(first.filePath ?? "", /call_1-[0-9a-f]{64}\.txt$/);
  assert.match(first.output, /Preview \(first 3 characters\):\nabc/);
  assert.equal(await fs.readFile(first.filePath!, "utf8"), "abcdefgh");
});
