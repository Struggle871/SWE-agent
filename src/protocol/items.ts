import type { CallId, RequestId, StepId, TurnId, WindowId } from "./ids.js";
import type { Usage } from "./usage.js";

/** Canonical message shape shared by request, history and transcript projections. */
export interface CanonicalMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  usage?: Usage;
  reasoning?: string;
  requestId?: RequestId;
  toolCalls?: Array<{ callId: CallId; name: string; input: unknown }>;
  toolCallId?: CallId;
}

export interface ResponseItemMetadata {
  kind: "conversation" | "context_injection" | "compaction_summary" | "remote_compaction";
  turnId?: TurnId;
  stepId?: StepId;
  usageAnchor?: { requestId: RequestId; requestHistoryVersion: number; requestFingerprint: string; windowId: WindowId; observed: boolean };
  provider?: Record<string, unknown>;
}

/** Single canonical envelope. `message` is the wire projection retained for legacy transports. */
export interface ResponseItemEnvelope {
  id: string;
  item: ResponseItem;
  metadata: ResponseItemMetadata;
  message: CanonicalMessage;
}

export interface ToolOutput {
  status: "ok" | "error" | "aborted";
  text: string;
  truncated: boolean;
  persistedPath?: string;
  metadata?: Record<string, unknown>;
}

export interface CompactWindow {
  startOrdinal: number;
  endOrdinal: number;
}

export type ResponseItem =
  | { kind: "user_text"; id: string; text: string; turnId?: TurnId }
  | { kind: "assistant_text"; id: string; text: string; turnId?: TurnId; stepId?: StepId; usage?: Usage }
  | { kind: "assistant_reasoning"; id: string; text: string; turnId: TurnId; stepId?: StepId }
  | { kind: "tool_call"; id: CallId; name: string; namespace?: string; input: unknown; turnId?: TurnId; stepId?: StepId }
  | { kind: "tool_calls"; id: string; calls: Array<{ callId: CallId; name: string; input: unknown }>; turnId?: TurnId; stepId?: StepId }
  | { kind: "tool_result"; id: string; callId: CallId; name: string; output: ToolOutput; turnId?: TurnId; stepId?: StepId }
  | { kind: "compact_checkpoint"; id: string; window: CompactWindow; summary: string }
  | { kind: "context_injection"; id: string; source: string; text: string }
  | { kind: "turn_aborted"; id: string; reason: string };
