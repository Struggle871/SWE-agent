import type { SessionId, StepId, TurnId, WindowId } from "../protocol/ids.js";
import { asWindowId } from "../protocol/ids.js";
import type { ApprovalResult } from "../security/approval-broker.js";
import type { ToolRisk } from "../tools/preview.js";
import type { Message, ToolResult } from "../types.js";
import type { ResponseItemEnvelope } from "../protocol/items.js";
import type { TurnTerminalReason } from "../core/events.js";
import type {
  CompactCheckpointPayload, CompactionLifecyclePayload, ContextItemEnvelope,
  ReferenceContextPayload, WorldStatePayload,
} from "../core/context/compaction-types.js";
import { validateLineage } from "../core/context/context-window.js";

export const TRANSCRIPT_SCHEMA_VERSION = 3 as const;
export type SupportedTranscriptSchemaVersion = 1 | 2 | typeof TRANSCRIPT_SCHEMA_VERSION;

export type TranscriptKind =
  | "session_meta" | "turn_started" | "turn_completed" | "turn_aborted" | "message"
  | "tool_call" | "tool_result" | "tool_preview" | "approval_requested" | "approval_resolved"
  | "interruption_marker" | "fork_created" | "compaction_lifecycle" | "compact_checkpoint"
  | "world_state" | "reference_context" | "rollback" | "hook_lifecycle" | "task_event" | "agent_event";

export interface TranscriptEnvelope {
  schemaVersion: SupportedTranscriptSchemaVersion;
  ordinal: number;
  timestamp: number;
  sessionId: SessionId;
  turnId?: TurnId;
  stepId?: StepId;
  kind: TranscriptKind;
  payload: TranscriptPayload;
  inheritedFrom?: { sessionId: SessionId; ordinal: number };
}

export type TranscriptPayload =
  | SessionMetaPayload | TurnStartedPayload | TurnCompletedPayload | TurnAbortedPayload | MessagePayload
  | ToolCallPayload | ToolResultPayload | ToolPreviewPayload | ApprovalRequestedPayload | ApprovalResolvedPayload
  | InterruptionMarkerPayload | ForkCreatedPayload | CompactionLifecyclePayload | CompactCheckpointPayload
  | WorldStatePayload | ReferenceContextPayload | RollbackPayload | HookLifecyclePayload | TaskEventPayload | AgentEventPayload;

export interface SessionMetaPayload {
  cwd: string;
  model: string;
  initialWindowId?: WindowId;
  parentSessionId?: SessionId;
  forkedAtOrdinal?: number;
}
export interface TurnStartedPayload { userRequest: string }
export interface TurnCompletedPayload { reason: TurnTerminalReason }
export interface TurnAbortedPayload { reason: string }
export type MessagePayload =
  | { item: ResponseItemEnvelope; message?: Message; contextItem?: ContextItemEnvelope }
  | { message: Message; contextItem?: ContextItemEnvelope; item?: ResponseItemEnvelope };
export interface ToolCallPayload { callId: string; name: string; input: Record<string, unknown>; sideEffecting: boolean }
export interface ToolResultPayload { callId: string; result: ToolResult }
export interface ToolPreviewPayload {
  callId: string; toolName: string; summary: string; risk: ToolRisk; cwd: string; affectedPaths: string[]; reasons: string[];
}
export interface ApprovalRequestedPayload { requestId: string; callId: string; permissionFingerprint: string }
export interface ApprovalResolvedPayload { requestId?: string; result: ApprovalResult }
export interface InterruptionMarkerPayload { incompleteTurnIds: TurnId[]; unknownOutcomeCallIds: string[] }
export interface ForkCreatedPayload { parentSessionId: SessionId; forkedAtOrdinal: number; reason?: string }
export interface RollbackPayload { throughOrdinal: number; reason?: string }
export interface HookLifecyclePayload {
  event: import("../types.js").HookEventName;
  hookId: string;
  status: "completed" | "failed" | "blocked" | "skipped";
  durationMs: number;
  reason?: string;
  rewritten: boolean;
  addedContext: boolean;
}
export interface TaskEventPayload { operation: "create" | "update" | "claim" | "complete" | "fail" | "cancel"; task: import("../types.js").Task }
export interface AgentEventPayload { agentId: string; event: "started" | "completed"; parentSessionId?: string; prompt?: string; status?: "completed" | "failed" | "cancelled"; result?: string; error?: string }

const KINDS = new Set<TranscriptKind>([
  "session_meta", "turn_started", "turn_completed", "turn_aborted", "message", "tool_call", "tool_result",
  "tool_preview", "approval_requested", "approval_resolved", "interruption_marker", "fork_created",
  "compaction_lifecycle", "compact_checkpoint", "world_state", "reference_context", "rollback", "hook_lifecycle", "task_event", "agent_event",
]);
const V1_KINDS = new Set<TranscriptKind>([
  "session_meta", "turn_started", "turn_completed", "turn_aborted", "message", "tool_call", "tool_result",
  "tool_preview", "approval_requested", "approval_resolved", "interruption_marker", "fork_created",
]);
const MAX_WIRE_CHECKPOINT_ITEMS = 10_000;
const MAX_WIRE_CHECKPOINT_BYTES = 10_000_000;
const MAX_WIRE_ITEM_BYTES = 1_000_000;

export function parseTranscriptEnvelope(value: unknown, lineNumber: number): TranscriptEnvelope {
  if (!isRecord(value)) throw invalid(lineNumber, "记录必须是对象");
  const record = value;
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2 && record.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION) {
    throw invalid(lineNumber, `不支持 schemaVersion ${String(record.schemaVersion)}`);
  }
  if (!Number.isInteger(record.ordinal) || (record.ordinal as number) < 0) throw invalid(lineNumber, "ordinal 必须是非负整数");
  if (typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp)) throw invalid(lineNumber, "timestamp 无效");
  if (typeof record.sessionId !== "string" || !record.sessionId) throw invalid(lineNumber, "sessionId 无效");
  if (typeof record.kind !== "string" || !KINDS.has(record.kind as TranscriptKind)) throw invalid(lineNumber, `未知 kind ${String(record.kind)}`);
  if (record.schemaVersion === 1 && !V1_KINDS.has(record.kind as TranscriptKind)) throw invalid(lineNumber, `schema v1 不支持 kind ${record.kind}`);
  if (!isRecord(record.payload)) throw invalid(lineNumber, "payload 必须是对象");
  validatePayload(record.kind as TranscriptKind, record.payload, lineNumber, record.schemaVersion as SupportedTranscriptSchemaVersion);
  return value as unknown as TranscriptEnvelope;
}

function validatePayload(kind: TranscriptKind, payload: Record<string, unknown>, line: number, version: SupportedTranscriptSchemaVersion): void {
  if (kind === "session_meta") {
    if (typeof payload.cwd !== "string" || typeof payload.model !== "string") throw invalid(line, "session_meta 缺少 cwd/model");
    if (payload.initialWindowId !== undefined) asWindowIdValue(payload.initialWindowId, line);
  } else if (kind === "message") {
    if (version >= 3 && payload.item === undefined) throw invalid(line, "v3 message 缺少 canonical item");
    if (payload.message !== undefined && !isMessage(payload.message)) throw invalid(line, "message payload 无效");
    if (payload.item !== undefined) validateContextItem(payload.item, line, version >= 3);
    if (payload.contextItem !== undefined) validateContextItem(payload.contextItem, line);
  } else if (kind === "compact_checkpoint") {
    validateCheckpoint(payload, line);
  } else if (kind === "world_state") {
    if (typeof payload.full !== "boolean" || !isRecord(payload.state) || typeof payload.fingerprint !== "string") throw invalid(line, "world_state payload 无效");
  } else if (kind === "reference_context") {
    if (typeof payload.cleared !== "boolean") throw invalid(line, "reference_context.cleared 无效");
  } else if (kind === "rollback") {
    if (!Number.isInteger(payload.throughOrdinal) || (payload.throughOrdinal as number) < 0) throw invalid(line, "rollback.throughOrdinal 无效");
  } else if (kind === "hook_lifecycle") {
    if (typeof payload.event !== "string" || typeof payload.hookId !== "string" || !["completed", "failed", "blocked", "skipped"].includes(String(payload.status)) || typeof payload.durationMs !== "number" || typeof payload.rewritten !== "boolean" || typeof payload.addedContext !== "boolean") throw invalid(line, "hook_lifecycle payload 无效");
  } else if (kind === "task_event") {
    if (!["create", "update", "claim", "complete", "fail", "cancel"].includes(String(payload.operation)) || !isRecord(payload.task) || typeof payload.task.id !== "string" || typeof payload.task.description !== "string") throw invalid(line, "task_event payload 无效");
  } else if (kind === "agent_event") {
    if (typeof payload.agentId !== "string" || !["started", "completed"].includes(String(payload.event))) throw invalid(line, "agent_event payload 无效");
  }
}

function validateCheckpoint(payload: Record<string, unknown>, line: number): void {
  if (payload.status !== "completed" || typeof payload.compactionId !== "string") throw invalid(line, "checkpoint 标识或状态无效");
  if (!Array.isArray(payload.replacementHistory)) throw invalid(line, "checkpoint replacementHistory 缺失");
  if (payload.replacementHistory.length > MAX_WIRE_CHECKPOINT_ITEMS) throw invalid(line, "checkpoint item 数超限");
  let total = 0;
  for (const item of payload.replacementHistory) {
    validateContextItem(item, line);
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes > MAX_WIRE_ITEM_BYTES) throw invalid(line, "checkpoint 单 item 超限");
    total += bytes;
  }
  if (total > MAX_WIRE_CHECKPOINT_BYTES) throw invalid(line, "checkpoint 总大小超限");
  if (!isRecord(payload.window)) throw invalid(line, "checkpoint window 缺失");
  try {
    validateLineage({
      windowNumber: Number(payload.window.windowNumber),
      firstWindowId: asWindowIdValue(payload.window.firstWindowId, line),
      ...(payload.window.previousWindowId === undefined ? {} : { previousWindowId: asWindowIdValue(payload.window.previousWindowId, line) }),
      windowId: asWindowIdValue(payload.window.windowId, line),
    });
  } catch (error) {
    throw invalid(line, `checkpoint window 无效: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Number.isInteger(payload.sourceThroughOrdinal) || (payload.sourceThroughOrdinal as number) < -1) throw invalid(line, "checkpoint sourceThroughOrdinal 无效");
}

function validateContextItem(value: unknown, line: number, requireItem = false): asserts value is ContextItemEnvelope {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || !isMessage(value.message) || !isRecord(value.metadata)) {
    throw invalid(line, "context item envelope 无效");
  }
  if (!["conversation", "context_injection", "compaction_summary", "remote_compaction"].includes(String(value.metadata.kind))) {
    throw invalid(line, "context item metadata.kind 无效");
  }
  if (requireItem && !isRecord(value.item)) throw invalid(line, "canonical response item 缺失");
}

function isMessage(value: unknown): value is Message {
  return isRecord(value) && ["system", "developer", "user", "assistant", "tool"].includes(String(value.role)) && typeof value.content === "string";
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function asWindowIdValue(value: unknown, line: number): WindowId {
  if (typeof value !== "string" || !value) throw invalid(line, "window id 无效");
  return asWindowId(value);
}
function invalid(lineNumber: number, message: string): Error { return new Error(`Transcript 第 ${lineNumber} 行损坏: ${message}`); }
