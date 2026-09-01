import type { ChatOptions, Message, ModelClient, ModelStreamEvent, Usage } from "../types.js";
import { createCallId, asCallId, type CallId } from "../protocol/ids.js";
import type { ModelCapabilities, ModelEvent, ModelRequest, ModelTransport } from "../protocol/model-events.js";
import { LegacyModelTransportAdapter } from "./transport.js";
import { parseOpenAIChatSse } from "./openai-sse.js";

export class OpenAIChatModelClient implements ModelClient {
  readonly transport: ModelTransport;

  constructor(private opts: { baseUrl: string; apiKey?: string; model: string }) {
    this.transport = new OpenAIChatModelTransport(opts);
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<string> {
    const url = this.opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers["authorization"] = `Bearer ${this.opts.apiKey}`;

    const body = JSON.stringify({
      model: this.opts.model,
      messages,
      temperature: options?.temperature ?? 0,
      max_tokens: options?.maxTokens,
    });

    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers, body });
      } catch (e) {
        // 网络错误：可重试
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < maxAttempts) {
          await sleep(2000 * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      }

      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        return data.choices?.[0]?.message?.content ?? "";
      }

      const status = res.status;
      const text = await res.text();
      const err = new Error(`模型调用失败 (${status}): ${text}`);

      // 429/5xx 属于瞬时错误，进行指数退避重试；其余错误直接抛出
      if ((status === 429 || status >= 500) && attempt < maxAttempts) {
        lastError = err;
        await sleep(2000 * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }

    throw lastError ?? new Error("模型调用失败");
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<ModelStreamEvent> {
    const url = this.opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers["authorization"] = `Bearer ${this.opts.apiKey}`;

    const body = JSON.stringify({
      model: this.opts.model,
      messages,
      temperature: options?.temperature ?? 0,
      max_tokens: options?.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    });

    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body });
    } catch {
      // 网络失败：回退非流式（自带重试）
      const text = await this.chat(messages, options);
      yield { type: "text_delta", text };
      yield { type: "done", raw: text };
      return;
    }

    if (!res.ok || !res.body) {
      const text = await this.chat(messages, options);
      yield { type: "text_delta", text };
      yield { type: "done", raw: text };
      return;
    }

    let full = "";
    let usage: Usage | undefined;
    for await (const chunk of parseOpenAIChatSse(res.body)) {
      if (chunk.textDelta) {
        full += chunk.textDelta;
        yield { type: "text_delta", text: chunk.textDelta };
      }
      if (chunk.usage) usage = chunk.usage;
    }

    yield { type: "done", raw: full, usage };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeModelClient implements ModelClient {
  private calls = 0;
  readonly transport: ModelTransport;

  constructor(private command: string = process.platform === "win32" ? "dir" : "ls") {
    this.transport = new FakeModelTransport(this);
  }

  async chat(_messages: Message[], _options?: ChatOptions): Promise<string> {
    this.calls += 1;
    if (this.calls === 1) {
      return JSON.stringify({
        thought: "先查看当前工作目录",
        action: "run_command",
        action_input: { command: this.command },
      });
    }
    return JSON.stringify({
      thought: "已经完成演示",
      action: "final_answer",
      action_input: { answer: "（FakeModel 演示）已完成一轮工具调用并返回最终答案。" },
    });
  }

  async *stream(messages: Message[], options?: ChatOptions): AsyncGenerator<ModelStreamEvent> {
    const text = await this.chat(messages, options);
    for (const ch of text) {
      yield { type: "text_delta", text: ch };
      await sleep(2);
    }
    yield { type: "done", raw: text };
  }
}

/**
 * Native OpenAI Chat Completions event adapter. The legacy client remains
 * available for providers that only support the JSON/ReAct prompt contract.
 */
class OpenAIChatModelTransport implements ModelTransport {
  constructor(private readonly opts: { baseUrl: string; apiKey?: string; model: string }) {}

  capabilities(): ModelCapabilities {
    return { nativeToolCalls: true, streamingText: true, usage: true, reasoningDeltas: false };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    yield { type: "response_started", requestId: request.requestId };
    const body = JSON.stringify({
      model: this.opts.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.tools && request.tools.length > 0
        ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) }
        : {}),
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;

    let response: Response;
    try {
      response = await fetch(this.opts.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST", headers, body, signal,
      });
    } catch (error) {
      yield { type: "transport_warning", message: error instanceof Error ? error.message : String(error), recoverable: true };
      yield* this.fallback(request, signal);
      return;
    }
    if (!response.ok || !response.body) {
      const detail = response.body ? await response.text() : `HTTP ${response.status}`;
      yield { type: "transport_warning", message: `模型流式请求失败: ${response.status} ${detail}`, recoverable: true };
      yield* this.fallback(request, signal);
      return;
    }

    const calls = new Map<number, { callId: CallId; name: string; args: string; started: boolean }>();
    let finishReason = "stop";
    let usage: Usage | undefined;
    for await (const chunk of parseOpenAIChatSse(response.body, signal)) {
      if (chunk.textDelta) yield { type: "text_delta", text: chunk.textDelta };
      if (chunk.usage) usage = chunk.usage;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      for (const delta of chunk.toolCalls) {
        let call = calls.get(delta.index);
        if (!call) {
          call = { callId: delta.id ? asCallId(delta.id) : createCallId(), name: delta.name ?? "", args: "", started: false };
          calls.set(delta.index, call);
        } else if (delta.name) {
          call.name += delta.name;
        }
        if (!call.started && call.name) {
          call.started = true;
          yield { type: "tool_call_started", callId: call.callId, name: call.name };
        }
        if (delta.arguments) {
          call.args += delta.arguments;
          yield { type: "tool_call_delta", callId: call.callId, jsonDelta: delta.arguments };
        }
      }
    }
    if (usage) yield { type: "usage", usage, requestId: request.requestId };
    for (const call of calls.values()) {
      let input: unknown;
      try { input = JSON.parse(call.args || "{}"); } catch (error) {
        throw new Error(`原生 tool call 参数不是有效 JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      yield { type: "tool_call_completed", callId: call.callId, input };
    }
    yield { type: "response_completed", finishReason };
  }

  private async *fallback(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const legacy = new OpenAIChatModelClient(this.opts);
    const adapter = new LegacyModelTransportAdapter(legacy);
    let skippedStart = false;
    for await (const event of adapter.stream(request, signal)) {
      if (event.type === "response_started" && !skippedStart) { skippedStart = true; continue; }
      yield event;
    }
  }
}

class FakeModelTransport implements ModelTransport {
  constructor(private readonly model: FakeModelClient) {}

  capabilities(): ModelCapabilities {
    return { nativeToolCalls: true, streamingText: true, usage: true, reasoningDeltas: false };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) throw signal.reason ?? new Error("模型请求已取消");
    yield { type: "response_started", requestId: request.requestId };
    const raw = await this.model.chat(request.messages as Message[], { maxTokens: request.maxOutputTokens, temperature: request.temperature });
    const parsed = safeJson(raw);
    if (parsed?.action && parsed.action !== "final_answer" && typeof parsed.action === "string") {
      const callId = createCallId();
      const input = parsed.action_input && typeof parsed.action_input === "object" ? parsed.action_input : {};
      yield { type: "tool_call_started", callId, name: parsed.action };
      yield { type: "tool_call_delta", callId, jsonDelta: JSON.stringify(input) };
      yield { type: "tool_call_completed", callId, input };
    } else {
      const answer = parsed?.action === "final_answer" && parsed.action_input && typeof parsed.action_input === "object"
        ? String((parsed.action_input as Record<string, unknown>).answer ?? raw)
        : raw;
      yield { type: "text_delta", text: answer };
    }
    yield { type: "usage", usage: { inputTokens: request.messages.length, outputTokens: 1, totalTokens: request.messages.length + 1 }, requestId: request.requestId };
    yield { type: "response_completed", finishReason: "stop" };
  }
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}


