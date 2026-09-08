// Session/Turn 生命周期事件与故障恢复继续原因。

export type SessionState = "created" | "ready" | "running" | "waiting_approval" | "closing" | "closed";
export type TurnState =
  | "created"
  | "preflight_context"
  | "precompact"
  | "sampling"
  | "dispatching_tools"
  | "awaiting_followup"
  | "compacting"
  | "completed"
  | "aborted"
  | "failed";

export type TurnTerminalReason =
  | "completed"
  | "max_steps"
  | "task_queue_empty"
  | "parse_failed"
  | "cancelled"
  | "failed";

export type AgentEvent =
  | { type: "session_started"; sessionId: import("../protocol/ids.js").SessionId }
  | { type: "session_state_changed"; sessionId: import("../protocol/ids.js").SessionId; state: SessionState }
  | { type: "turn_started"; sessionId: import("../protocol/ids.js").SessionId; turnId: import("../protocol/ids.js").TurnId }
  | { type: "turn_state_changed"; sessionId: import("../protocol/ids.js").SessionId; turnId: import("../protocol/ids.js").TurnId; state: TurnState }
  | { type: "step_started"; sessionId: import("../protocol/ids.js").SessionId; turnId: import("../protocol/ids.js").TurnId; stepId: import("../protocol/ids.js").StepId }
  | { type: "step_completed"; sessionId: import("../protocol/ids.js").SessionId; turnId: import("../protocol/ids.js").TurnId; stepId: import("../protocol/ids.js").StepId; continueReason?: ContinueReason }
  | { type: "turn_completed"; sessionId: import("../protocol/ids.js").SessionId; turnId: import("../protocol/ids.js").TurnId; reason: TurnTerminalReason }
  | { type: "turn_aborted"; sessionId: import("../protocol/ids.js").SessionId; turnId: import("../protocol/ids.js").TurnId; reason: string }
  | { type: "stream_start" }
  | { type: "stream_delta"; delta: string }
  | { type: "model_event"; event: import("../protocol/model-events.js").ModelEvent }
  | { type: "assistant_message"; message: import("../types.js").Message }
  | { type: "tool_use_started"; toolName: string; callId: string }
  | { type: "tool_use_completed"; toolName: string; isError: boolean }
  | { type: "tool_preview"; preview: import("../tools/preview.js").ToolExecutionPreview }
  | { type: "approval_requested"; request: import("../security/approval-broker.js").ApprovalRequest }
  | { type: "approval_resolved"; result: import("../security/approval-broker.js").ApprovalResult }
  | { type: "compact_boundary" }
  | {
    type: "compaction";
    status: "started" | "completed" | "failed" | "interrupted";
    compactionId: string;
    phase: import("./context/compaction-types.js").CompactionPhase;
    reason: import("./context/compaction-types.js").CompactionReason;
    implementation?: import("./context/compaction-types.js").CompactionImplementation;
    errorCode?: import("./context/compaction-types.js").CompactionErrorCode;
  }
  | { type: "api_error"; error: Error; recoverable: boolean }
  | { type: "final_answer"; answer: string }
  | { type: "max_steps_reached" }
  | { type: "max_turns_reached" };

// 每次继续推进 turn 的原因。M4 开始由 runStep / TurnRunner 实际产生。
export type ContinueReason =
  | "normal"
  | "parse_retry"
  | "max_output_tokens_upgrade"
  | "context_compacted"
  | "transport_fallback"
  | "tool_error_recoverable"
  | "auto_compact_failed";
