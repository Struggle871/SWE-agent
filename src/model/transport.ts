import type { Message, ModelClient, ModelStreamEvent } from "../types.js";
import { asCallId, asRequestId } from "../protocol/ids.js";
import type {
  ModelCapabilities,
  ModelEvent,
  ModelRequest,
  ModelTransport,
} from "../protocol/model-events.js";
import { legacyModelCapabilities } from "../protocol/model-events.js";

/** 将 M0/M1 的 chat 或旧 stream 接口适配成 M2 事件流。 */
export class LegacyModelTransportAdapter implements ModelTransport {
  constructor(private readonly model: ModelClient) {}

  capabilities(): ModelCapabilities {
    return legacyModelCapabilities;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    if (signal.aborted) throw signal.reason ?? new Error("模型请求已取消");
    yield { type: "response_started", requestId: request.requestId };

    const messages = request.messages as Message[];
    const options = {
      temperature: request.temperature,
      maxTokens: request.maxOutputTokens,
    };
    const source: AsyncIterable<ModelStreamEvent> = this.model.stream
      ? this.model.stream(messages, options)
      : singleChat(this.model, messages, options);

    for await (const event of source) {
      if (signal.aborted) throw signal.reason ?? new Error("模型请求已取消");
      if (event.type === "text_delta") yield { type: "text_delta", text: event.text };
      else if (event.type === "done") {
        if (event.usage) yield { type: "usage", usage: event.usage, requestId: request.requestId };
        yield { type: "response_completed", finishReason: "stop" };
      }
    }
  }
}

async function* singleChat(
  model: ModelClient,
  messages: Message[],
  options: { temperature?: number; maxTokens?: number },
): AsyncIterable<ModelStreamEvent> {
  const text = await model.chat(messages, options);
  yield { type: "text_delta", text };
  yield { type: "done", raw: text };
}

export function modelTransportFor(model: ModelClient): ModelTransport {
  return model.transport ?? new LegacyModelTransportAdapter(model);
}

export function requestIdFrom(value: string) {
  return asRequestId(value);
}

export function callIdFrom(value: string) {
  return asCallId(value);
}
