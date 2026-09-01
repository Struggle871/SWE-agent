import type { Usage } from "../types.js";

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface OpenAIStreamChunk {
  textDelta?: string;
  toolCalls: OpenAIToolCallDelta[];
  usage?: Usage;
  finishReason?: string;
}

/** 唯一的 Chat Completions SSE 分片解析器，供 legacy 和 native transport 共用。 */
export async function* parseOpenAIChatSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<OpenAIStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (signal?.aborted) throw signal.reason ?? new Error("模型请求已取消");
    buffer += decoder.decode(value, { stream: true });
    let separator: RegExpMatchArray | null;
    while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const index = separator.index ?? 0;
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + separator[0].length);
      const parsed = parseSseBlock(block);
      if (parsed) yield parsed;
    }
  }

  buffer += decoder.decode();
  const parsed = parseSseBlock(buffer);
  if (parsed) yield parsed;
}

function parseSseBlock(block: string): OpenAIStreamChunk | undefined {
  const dataLines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  for (const payload of dataLines) {
    if (payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const choice = json.choices?.[0];
      const toolCalls = (choice?.delta?.tool_calls ?? []).map((call) => ({
        index: call.index ?? 0,
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments,
      }));
      return {
        textDelta: choice?.delta?.content || undefined,
        toolCalls,
        finishReason: choice?.finish_reason ?? undefined,
        usage: json.usage
          ? {
              inputTokens: json.usage.prompt_tokens ?? 0,
              outputTokens: json.usage.completion_tokens ?? 0,
              totalTokens: json.usage.total_tokens ?? 0,
            }
          : undefined,
      };
    } catch {
      // provider 分片不完整或格式错误时跳过该分片，不能把残缺参数交给工具。
    }
  }
  return undefined;
}
