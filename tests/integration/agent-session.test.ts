import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "../../src/core/agent-session.js";
import type { ChatOptions, Message, ModelClient } from "../../src/types.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";

test("FakeModel completes one tool call end to end", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const events: string[] = [];
  const result = await new AgentSession(ctx, (event) => events.push(event.type)).run("inspect");
  assert.equal(result.steps, 1);
  assert.match(result.answer, /FakeModel/);
  assert.ok(events.includes("tool_preview"));
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
  assert.match(result.taskTrace[0].action.type === "final_answer" ? result.taskTrace[0].action.answer : "", /解析失败/);
});
