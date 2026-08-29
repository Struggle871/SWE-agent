import type { ChatOptions, Message, ModelClient, ModelStreamEvent, Usage } from "../types.js";

export class OpenAIChatModelClient implements ModelClient {
  constructor(private opts: { baseUrl: string; apiKey?: string; model: string }) {}

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

    // 解析 SSE（OpenAI chat/completions 流式：data: {...}\n\n ... data: [DONE]）
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let usage: Usage | undefined;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload) as {
              choices?: { delta?: { content?: string } }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            if (json.usage) {
              usage = {
                inputTokens: json.usage.prompt_tokens ?? 0,
                outputTokens: json.usage.completion_tokens ?? 0,
                totalTokens: json.usage.total_tokens ?? 0,
              };
            }
            const delta = json.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              full += delta;
              yield { type: "text_delta", text: delta };
            }
          } catch {
            // 忽略无法解析的分片
          }
        }
      }
    }

    yield { type: "done", raw: full, usage };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeModelClient implements ModelClient {
  private calls = 0;
  constructor(private command: string = process.platform === "win32" ? "dir" : "ls") {}

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


