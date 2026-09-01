import type { CallId, RequestId } from "./ids.js";
import type { Usage } from "./usage.js";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  usage?: Usage;
  toolCalls?: Array<{ callId: CallId; name: string; input: unknown }>;
  toolCallId?: CallId;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ModelRequest {
  requestId: RequestId;
  messages: readonly ModelMessage[];
  tools?: readonly ModelToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ModelCapabilities {
  nativeToolCalls: boolean;
  streamingText: boolean;
  usage: boolean;
  reasoningDeltas: boolean;
}

export type ModelEvent =
  | { type: "response_started"; requestId: RequestId }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_started"; callId: CallId; name: string }
  | { type: "tool_call_delta"; callId: CallId; jsonDelta: string }
  | { type: "tool_call_completed"; callId: CallId; input: unknown }
  | { type: "usage"; usage: Usage; requestId?: RequestId }
  | { type: "transport_warning"; message: string; recoverable: boolean }
  | { type: "response_completed"; finishReason: string };

export interface ModelTransport {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  capabilities(): ModelCapabilities;
}

export const legacyModelCapabilities: ModelCapabilities = {
  nativeToolCalls: false,
  streamingText: true,
  usage: true,
  reasoningDeltas: false,
};
