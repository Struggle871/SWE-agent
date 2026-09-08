import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "../../src/core/agent-session.js";
import type { AgentEvent } from "../../src/core/events.js";
import type { ChatOptions, Message, ModelClient } from "../../src/types.js";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/protocol/model-events.js";
import { createCallId } from "../../src/protocol/ids.js";
import type { Tool } from "../../src/tools/types.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";

test("FakeModel completes one tool call end to end", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const events: AgentEvent[] = [];
  const result = await new AgentSession(ctx, (event) => events.push(event)).run("inspect");
  assert.equal(result.steps, 2);
  assert.match(result.answer, /FakeModel/);
  assert.ok(events.some((event) => event.type === "tool_preview"));
  assert.equal(events.filter((event) => event.type === "session_started").length, 1);
  assert.equal(events.filter((event) => event.type === "turn_started").length, 1);
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 1);
  assert.equal(events.filter((event) => event.type === "step_started").length, 2);
  assert.equal(events.filter((event) => event.type === "step_completed").length, 2);
  assert.match(result.sessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.match(result.turnId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(result.taskTrace.length, 2);
  assert.ok(result.taskTrace.every((step) => step.turnId === result.turnId));
  assert.equal(new Set(result.taskTrace.map((step) => step.stepId)).size, 2);
  assert.equal(result.terminalReason, "completed");
});

test("native tool calls keep a stable call id through the executor and audit trail", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const result = await new AgentSession(ctx).run("inspect");
  const toolStep = result.taskTrace.find((step) => step.action.type === "tool_call");
  const toolAction = toolStep?.action;
  assert.ok(toolAction && toolAction.type === "tool_call");
  if (!toolAction || toolAction.type !== "tool_call" || !toolStep) return;
  assert.match(toolAction.callId ?? "", /^[0-9a-f-]{36}$/);
  const records = ctx.auditTrail.list();
  assert.ok(records.some((record) => record.callId === toolAction.callId && record.phase === "preflight"));
  assert.ok(records.some((record) => record.callId === toolAction.callId && record.phase === "execution"));
});

test("repeated parse failure terminates according to parseRetry", async (t) => {
  class InvalidModel implements ModelClient {
    calls = 0;
    async chat(_messages: Message[], _options?: ChatOptions): Promise<string> { this.calls += 1; return "invalid"; }
  }
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const model = new InvalidModel();
  ctx.model = model;
  ctx.config.parseRetry = 2;
  const result = await new AgentSession(ctx).run("fail parsing");
  assert.equal(model.calls, 3);
  assert.equal(result.steps, 1);
  assert.match(result.taskTrace[0].action.type === "final_answer" ? result.taskTrace[0].action.answer : "", /解析失败/);
  assert.equal(result.taskTrace[0].continueReason, "parse_retry");
});

test("concurrent runs are serialized into separate turns", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const events: AgentEvent[] = [];
  const session = new AgentSession(ctx, (event) => events.push(event));
  const [first, second] = await Promise.all([session.run("first"), session.run("second")]);
  assert.notEqual(first.turnId, second.turnId);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(session.hasActiveTurn, false);
  assert.equal(events.filter((event) => event.type === "session_started").length, 1);
  assert.equal(events.filter((event) => event.type === "turn_completed").length, 2);
});

test("interrupt cancels an in-flight model request and reports a terminal reason", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  let started = false;
  const transport: ModelTransport = {
    capabilities: () => ({ nativeToolCalls: true, streamingText: true, usage: false, reasoningDeltas: false }),
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      yield { type: "response_started", requestId: request.requestId };
      started = true;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("cancelled"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        void resolve;
      });
    },
  };
  ctx.model = { chat: async () => "", transport };
  const events: AgentEvent[] = [];
  const session = new AgentSession(ctx, (event) => events.push(event));
  const running = session.run("block");
  while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
  session.interrupt("测试中断");
  const result = await running;
  assert.equal(result.terminalReason, "cancelled");
  assert.equal(session.hasActiveTurn, false);
  assert.ok(events.some((event) => event.type === "turn_aborted" && event.reason.includes("测试中断")));
  assert.ok(events.some((event) => event.type === "turn_completed" && event.reason === "cancelled"));
});

test("interrupt cancels an in-flight tool runtime", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  let toolStarted = false;
  const slowTool: Tool = {
    name: "slow_tool",
    description: "slow",
    isReadOnly: true,
    parameters: { type: "object", properties: {} },
    async execute(_input, _ctx, options) {
      toolStarted = true;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(options?.signal?.reason ?? new Error("cancelled"));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
        void resolve;
      });
      return { toolName: "slow_tool", output: "unreachable" };
    },
  };
  ctx.registry.register(slowTool);
  const transport: ModelTransport = {
    capabilities: () => ({ nativeToolCalls: true, streamingText: true, usage: false, reasoningDeltas: false }),
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      yield { type: "response_started", requestId: request.requestId };
      const callId = createCallId();
      yield { type: "tool_call_started", callId, name: "slow_tool" };
      yield { type: "tool_call_completed", callId, input: {} };
      yield { type: "response_completed", finishReason: "tool_calls" };
    },
  };
  ctx.model = { chat: async () => "", transport };
  const session = new AgentSession(ctx);
  const running = session.run("tool");
  while (!toolStarted) await new Promise((resolve) => setTimeout(resolve, 1));
  session.interrupt("停止工具");
  const result = await running;
  assert.equal(result.terminalReason, "cancelled");
});

test("steer input is injected before the next sampling request", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  let call = 0;
  let sawSteer = false;
  const transport: ModelTransport = {
    capabilities: () => ({ nativeToolCalls: true, streamingText: true, usage: false, reasoningDeltas: false }),
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      call += 1;
      yield { type: "response_started", requestId: request.requestId };
      if (call === 1) {
        const callId = createCallId();
        yield { type: "tool_call_started", callId, name: "slow_tool" };
        yield { type: "tool_call_completed", callId, input: {} };
      } else {
        sawSteer = request.messages.some((message) => message.role === "user" && message.content === "继续检查");
        yield { type: "text_delta", text: "已收到引导" };
      }
      yield { type: "response_completed", finishReason: "stop" };
    },
  };
  ctx.registry.register({
    name: "slow_tool",
    description: "fast",
    isReadOnly: true,
    parameters: { type: "object", properties: {} },
    async execute() { return { toolName: "slow_tool", output: "ok" }; },
  });
  ctx.model = { chat: async () => "", transport };
  const session = new AgentSession(ctx);
  const running = session.run("tool");
  session.steer("继续检查");
  const result = await running;
  assert.equal(result.terminalReason, "completed");
  assert.equal(sawSteer, true);
});
