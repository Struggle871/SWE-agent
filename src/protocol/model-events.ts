import type { CallId, RequestId } from "./ids.js";
import type { Usage } from "./usage.js";
import type { ResponseItemEnvelope } from "./items.js";

export interface ModelMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  usage?: Usage;
  reasoning?: string;
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
  items?: readonly ResponseItemEnvelope[];
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
  remoteCompaction?: "unsupported" | "v1" | "v2";
}

export interface RemoteCompactionRequest {
  requestId: RequestId;
  implementation: "remote_compact" | "remote_compaction_v2";
  model: string;
  input: readonly ModelMessage[];
  instructions: string;
  tools: readonly ModelToolDefinition[];
  parallelToolCalls: boolean;
  maxOutputTokens: number;
  promptCacheKey?: string;
  serviceTier?: string;
  reasoning?: Record<string, unknown>;
}

export interface RemoteCompactionResult {
  replacement: readonly ModelMessage[];
  usage?: Usage;
  responseId?: string;
  metadata?: readonly (Record<string, unknown> | undefined)[];
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
  compact?(request: RemoteCompactionRequest, signal: AbortSignal): Promise<RemoteCompactionResult>;
}

export const legacyModelCapabilities: ModelCapabilities = {
  nativeToolCalls: false,
  streamingText: true,
  usage: true,
  reasoningDeltas: false,
};
