import type { CallId, RequestId, SessionId, StepId, TurnId } from "./ids.js";
import type { ModelEvent } from "./model-events.js";
import type { ResponseItem } from "./items.js";
import type { TurnTerminalReason } from "../core/events.js";

export type ProtocolAgentEvent =
  | { type: "session_started"; sessionId: SessionId }
  | { type: "turn_started"; sessionId: SessionId; turnId: TurnId }
  | { type: "step_started"; sessionId: SessionId; turnId: TurnId; stepId: StepId }
  | { type: "model_event"; sessionId: SessionId; turnId: TurnId; stepId: StepId; requestId: RequestId; event: ModelEvent }
  | { type: "response_item"; sessionId: SessionId; turnId: TurnId; stepId?: StepId; item: ResponseItem }
  | { type: "step_completed"; sessionId: SessionId; turnId: TurnId; stepId: StepId }
  | { type: "turn_completed"; sessionId: SessionId; turnId: TurnId; reason: TurnTerminalReason }
  | { type: "tool_call"; sessionId: SessionId; turnId: TurnId; stepId: StepId; callId: CallId; name: string };
