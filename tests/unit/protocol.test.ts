import assert from "node:assert/strict";
import test from "node:test";
import { asCallId, asHistoryOrdinal, asRequestId, asStepId, createCallId, createStepId } from "../../src/protocol/ids.js";
import { isAgentError } from "../../src/protocol/errors.js";
import { FakeModelClient } from "../../src/model/model-client.js";
import { LegacyModelTransportAdapter } from "../../src/model/transport.js";
import type { Message, ModelClient } from "../../src/types.js";
import type { ModelRequest } from "../../src/protocol/model-events.js";

test("branded protocol ids validate at runtime and call ids are unique", () => {
  const first = createCallId();
  const second = createCallId();
  assert.notEqual(first, second);
  assert.notEqual(createStepId(), createStepId());
  assert.equal(asCallId(first), first);
  assert.equal(asRequestId("request-1"), "request-1");
  assert.equal(asStepId("step-1"), "step-1");
  assert.equal(asHistoryOrdinal(0), 0);
  assert.throws(() => asRequestId(""), /不能为空/);
  assert.throws(() => asHistoryOrdinal(-1), /非负整数/);
});

test("FakeModel exposes a structured tool call with correlated request and usage ids", async () => {
  const model = new FakeModelClient("dir");
  const request: ModelRequest = {
    requestId: asRequestId("request-1"),
    messages: [{ role: "user", content: "inspect" }],
  };
  const events = [];
  for await (const event of model.transport!.stream(request, new AbortController().signal)) events.push(event);
  assert.deepEqual(events.map((event) => event.type), [
    "response_started", "tool_call_started", "tool_call_delta", "tool_call_completed", "usage", "response_completed",
  ]);
  assert.equal(events[0].type === "response_started" ? events[0].requestId : "", request.requestId);
  const callIds = events.filter((event) => "callId" in event).map((event) => event.callId);
  assert.equal(new Set(callIds).size, 1);
  assert.equal(events[4].type === "usage" ? events[4].requestId : "", request.requestId);
});

test("legacy chat-only models are converted to the M2 event protocol", async () => {
  const model: ModelClient = { chat: async (_messages: Message[]) => "legacy answer" };
  const request: ModelRequest = { requestId: asRequestId("request-legacy"), messages: [] };
  const events = [];
  for await (const event of new LegacyModelTransportAdapter(model).stream(request, new AbortController().signal)) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["response_started", "text_delta", "response_completed"]);
  assert.equal(events[1].type === "text_delta" ? events[1].text : "", "legacy answer");
});

test("AgentError remains a discriminated, non-string control value", () => {
  assert.equal(isAgentError({ kind: "permission", recoverable: true, message: "denied", callId: asCallId("call-1") }), true);
  assert.equal(isAgentError(new Error("denied")), false);
});
