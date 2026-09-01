import type { CallId, StepId, TurnId } from "./ids.js";
import type { Usage } from "./usage.js";

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
  | { kind: "user_text"; id: string; text: string; turnId: TurnId }
  | { kind: "assistant_text"; id: string; text: string; turnId: TurnId; stepId?: StepId; usage?: Usage }
  | { kind: "assistant_reasoning"; id: string; text: string; turnId: TurnId; stepId?: StepId }
  | { kind: "tool_call"; id: CallId; name: string; namespace?: string; input: unknown; turnId?: TurnId; stepId?: StepId }
  | { kind: "tool_result"; id: string; callId: CallId; name: string; output: ToolOutput; turnId?: TurnId; stepId?: StepId }
  | { kind: "compact_checkpoint"; id: string; window: CompactWindow; summary: string }
  | { kind: "context_injection"; id: string; source: string; text: string }
  | { kind: "turn_aborted"; id: string; reason: string };
