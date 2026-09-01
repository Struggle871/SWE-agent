import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "../../src/core/agent-session.js";
import type { AgentEvent } from "../../src/core/events.js";
import type { ChatOptions, Message, ModelClient } from "../../src/types.js";
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
});
