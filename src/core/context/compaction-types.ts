import type { CompactionId, RequestId, StepId, TurnId, WindowId } from "../../protocol/ids.js";
import type { Usage } from "../../protocol/usage.js";
import type { ResponseItemEnvelope, ResponseItemMetadata } from "../../protocol/items.js";
import type { Message } from "../../types.js";

export type CompactionTrigger = "manual" | "auto";
export type CompactionReason = "user_requested" | "context_limit" | "model_downshift" | "comp_hash_changed";
export type CompactionPhase = "standalone_turn" | "pre_turn" | "mid_turn";
export type CompactionImplementation = "local_responses" | "remote_compact" | "remote_compaction_v2" | "new_context_window";
export type CompactionStatus = "started" | "completed" | "failed" | "interrupted";

export interface ContextWindowLineage {
  windowNumber: number;
  firstWindowId: WindowId;
  previousWindowId?: WindowId;
  windowId: WindowId;
}

export interface UsageAnchorMetadata {
  requestId: RequestId;
  requestHistoryVersion: number;
  requestFingerprint: string;
  windowId: WindowId;
  observed: boolean;
}

export type ContextItemMetadata = ResponseItemMetadata & { usageAnchor?: UsageAnchorMetadata };
/** @deprecated Compatibility name. ResponseItemEnvelope is canonical. */
export type ContextItemEnvelope = ResponseItemEnvelope;

export interface WorldStatePayload {
  full: boolean;
  state: Record<string, unknown>;
  fingerprint: string;
}

export interface ReferenceContextPayload {
  cleared: boolean;
  model?: string;
  compHash?: string;
  contextLimit?: number;
  cwd?: string;
  instructionFingerprint?: string;
  skillCatalogFingerprint?: string;
  selectedSkillFingerprint?: string;
  memoryFingerprint?: string;
  configFingerprint?: string;
  requirementsFingerprint?: string;
  toolLayoutFingerprint?: string;
  permissionFingerprint?: string;
  worldStateFingerprint?: string;
}

export interface CompactionTokenUsage {
  activeBefore: number;
  activeAfter: number;
  estimateBefore: number;
  estimateAfter: number;
  cachedInputTokens?: number;
  backendUsage?: Usage;
}

export interface CompactCheckpointPayload {
  compactionId: CompactionId;
  trigger: CompactionTrigger;
  reason: CompactionReason;
  phase: CompactionPhase;
  implementation: CompactionImplementation;
  status: "completed";
  summary?: string;
  replacementHistory: ContextItemEnvelope[];
  window: ContextWindowLineage;
  tokenUsage: CompactionTokenUsage;
  sourceThroughOrdinal: number;
  sourceTurnIds: TurnId[];
  resourceOrigins?: Record<string, unknown>;
}

export interface CompactionLifecyclePayload {
  compactionId: CompactionId;
  trigger: CompactionTrigger;
  reason: CompactionReason;
  phase: CompactionPhase;
  implementation?: CompactionImplementation;
  status: Exclude<CompactionStatus, "completed">;
  errorCode?: CompactionErrorCode;
  message?: string;
}

export type CompactionErrorCode =
  | "compaction_interrupted"
  | "compaction_timeout"
  | "compaction_context_overflow"
  | "compaction_backend_failed"
  | "compaction_invalid_replacement"
  | "compaction_checkpoint_write_failed"
  | "compaction_baseline_write_failed"
  | "compaction_reconstruction_failed"
  | "compaction_no_progress"
  | "compaction_post_hook_stopped";

export interface TokenStatus {
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  hardLimit: number;
  autoCompactLimit: number;
  scope: "total" | "body_after_prefix";
  prefillTokens?: number;
  scopeTokens: number;
  hardLimitReached: boolean;
  autoCompactLimitReached: boolean;
  estimated: boolean;
}

export interface CompactionHookEvent {
  compactionId: CompactionId;
  trigger: CompactionTrigger;
  reason: CompactionReason;
  phase: CompactionPhase;
  implementation?: CompactionImplementation;
  window: ContextWindowLineage;
}

export interface CompactionHooks {
  preCompact?(event: CompactionHookEvent, signal: AbortSignal): Promise<"continue" | "stop"> | "continue" | "stop";
  postCompact?(event: CompactionHookEvent, signal: AbortSignal): Promise<"continue" | "stop"> | "continue" | "stop";
}

export interface CompactionResult {
  compactionId: CompactionId;
  checkpoint: CompactCheckpointPayload;
  postHookStopped: boolean;
}
