import assert from "node:assert/strict";
import test from "node:test";
import { asRequestId } from "../../src/protocol/ids.js";
import type { ModelRequest, RemoteCompactionRequest } from "../../src/protocol/model-events.js";
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

test("OpenAI transport sends Responses compact request shape and converts replacement items", async () => {
  const originalFetch = globalThis.fetch;
  let url = "";
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: "compact-1",
      output: [
        { type: "message", id: "msg-1", role: "user", content: [{ type: "input_text", text: "checkpoint" }] },
        { type: "function_call", id: "call-item", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
        { type: "function_call_output", id: "out-1", call_id: "call-1", output: "contents" },
      ],
      usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const model = new OpenAIChatModelClient({ baseUrl: "http://model/v1", model: "demo" });
    const request: RemoteCompactionRequest = {
      requestId: asRequestId("compact-request"),
      implementation: "remote_compact",
      model: "demo",
      input: [{ role: "user", content: "history" }],
      instructions: "compact",
      tools: [{ name: "read_file", description: "read", parameters: { type: "object" } }],
      parallelToolCalls: false,
      maxOutputTokens: 100,
    };
    const result = await model.transport!.compact!(request, new AbortController().signal);
    assert.equal(url, "http://model/v1/responses/compact");
    assert.equal(body?.parallel_tool_calls, false);
    assert.deepEqual((body?.tools as Array<Record<string, unknown>>)[0], {
      type: "function", name: "read_file", description: "read", parameters: { type: "object" },
    });
    assert.equal(result.responseId, "compact-1");
    assert.equal(result.replacement[0].content, "checkpoint");
    assert.equal(result.replacement[1].toolCalls?.[0].callId, "call-1");
    assert.equal(result.replacement[2].toolCallId, "call-1");
    assert.equal(result.usage?.totalTokens, 24);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
