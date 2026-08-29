// 主循环事件流与故障恢复继续原因（对齐 Claude Code query() 的 continue site）

export type AgentEvent =
  | { type: "stream_start" }
  | { type: "stream_delta"; delta: string }
  | { type: "assistant_message"; message: import("../types.js").Message }
  | { type: "tool_use_started"; toolName: string; callId: string }
  | { type: "tool_use_completed"; toolName: string; isError: boolean }
  | { type: "tool_preview"; preview: import("../tools/preview.js").ToolExecutionPreview }
  | { type: "approval_requested"; request: import("../security/approval-broker.js").ApprovalRequest }
  | { type: "approval_resolved"; result: import("../security/approval-broker.js").ApprovalResult }
  | { type: "compact_boundary" }
  | { type: "api_error"; error: Error; recoverable: boolean }
  | { type: "final_answer"; answer: string }
  | { type: "max_turns_reached" };

// 单轮循环的继续原因（Phase 1 先落地 normal / parse_retry，
// 其余站点在后续阶段实现 max_output_tokens_upgrade / compact / fallback）
export type ContinueReason =
  | "normal"
  | "parse_retry"
  | "max_output_tokens_upgrade"
  | "context_compacted"
  | "transport_fallback"
  | "tool_error_recoverable"
  | "auto_compact_failed";
