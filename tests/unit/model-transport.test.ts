import assert from "node:assert/strict";
import test from "node:test";
import { asRequestId } from "../../src/protocol/ids.js";
import type { ModelRequest } from "../../src/protocol/model-events.js";
import { OpenAIChatModelClient } from "../../src/model/model-client.js";

test("OpenAI transport converts native tool call SSE and usage into typed events", async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-native-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}\n\n',
    "data: [DONE]\n\n",
  ];
  globalThis.fetch = async () => new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const request: ModelRequest = { requestId: asRequestId("request-native"), messages: [] };
    const model = new OpenAIChatModelClient({ baseUrl: "http://model", model: "demo" });
    const events = [];
    for await (const event of model.transport!.stream(request, new AbortController().signal)) events.push(event);
    assert.deepEqual(events.map((event) => event.type), [
      "response_started", "tool_call_started", "tool_call_delta", "usage", "tool_call_completed", "response_completed",
    ]);
    const completed = events.find((event) => event.type === "tool_call_completed");
    assert.deepEqual(completed?.input, { path: "a.txt" });
    const usage = events.find((event) => event.type === "usage");
    assert.equal(usage?.type === "usage" ? usage.requestId : undefined, request.requestId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
