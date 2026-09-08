import { asWindowId, type SessionId, type TurnId } from "../protocol/ids.js";
import type { Message } from "../types.js";
import { envelope } from "../core/context/compaction-history.js";
import type {
  CompactCheckpointPayload, ContextItemEnvelope, ContextWindowLineage,
  ReferenceContextPayload, WorldStatePayload,
} from "../core/context/compaction-types.js";
import { applyWorldState } from "../core/context/world-state.js";
import { validateLineage } from "../core/context/context-window.js";
import type {
  MessagePayload, RollbackPayload, SessionMetaPayload, TranscriptEnvelope, ToolCallPayload, ToolResultPayload,
} from "./rollout-schema.js";

export interface UnknownToolOutcome {
  callId: string;
  name: string;
  sideEffecting: boolean;
  turnId?: TurnId;
}

export interface ReconstructedSession {
  sessionId: SessionId;
  meta: SessionMetaPayload;
  history: Message[];
  annotatedHistory: ContextItemEnvelope[];
  historyVersion: number;
  window: ContextWindowLineage;
  referenceContext?: ReferenceContextPayload;
  worldStateBaseline?: WorldStatePayload;
  previousTurnSettings?: { model: string; compHash?: string };
  latestCheckpointOrdinal?: number;
  incompleteTurnIds: TurnId[];
  pendingApprovalRequestIds: string[];
  unknownOutcomes: UnknownToolOutcome[];
  lastOrdinal: number;
}

export function reconstructSession(records: readonly TranscriptEnvelope[]): ReconstructedSession {
  const first = records[0];
  if (!first || first.kind !== "session_meta") throw new Error("Transcript 缺少首行 session_meta");
  const sessionId = first.sessionId;
  for (const record of records) {
    if (record.sessionId !== sessionId) throw new Error(`Transcript 混入其他 session: ${record.sessionId}`);
  }
  const surviving = applyRollbacks(records);
  const meta = first.payload as SessionMetaPayload;
  const checkpoints = surviving.filter((record) => record.kind === "compact_checkpoint");
  validateCheckpointChain(checkpoints, meta);
  const checkpointRecord = checkpoints.at(-1);
  const checkpoint = checkpointRecord?.payload as CompactCheckpointPayload | undefined;
  const baseOrdinal = checkpointRecord?.ordinal ?? -1;
  let annotatedHistory = structuredClone(checkpoint?.replacementHistory ?? []);
  let worldState: WorldStatePayload | undefined;
  let referenceContext: ReferenceContextPayload | undefined;
  const activeTurns = new Set<TurnId>();
  const pendingApprovals = new Set<string>();
  const openCalls = new Map<string, UnknownToolOutcome>();

  for (const record of surviving) {
    trackRecovery(record, activeTurns, pendingApprovals, openCalls);
    if (record.ordinal <= baseOrdinal) continue;
    if (record.kind === "message") {
      const payload = record.payload as MessagePayload;
      annotatedHistory.push(payload.contextItem
        ? structuredClone(payload.contextItem)
        : envelope(payload.message, {
          kind: "conversation",
          ...(record.turnId ? { turnId: record.turnId } : {}),
          ...(record.stepId ? { stepId: record.stepId } : {}),
        }, `legacy-${record.ordinal}`));
    } else if (record.kind === "world_state") {
      worldState = applyWorldState(worldState, record.payload as WorldStatePayload);
    } else if (record.kind === "reference_context") {
      const value = record.payload as ReferenceContextPayload;
      referenceContext = value.cleared ? undefined : structuredClone(value);
    }
  }

  let window = checkpoint?.window ?? {
    windowNumber: 0,
    firstWindowId: meta.initialWindowId ?? asWindowId(`legacy-${sessionId}`),
    windowId: meta.initialWindowId ?? asWindowId(`legacy-${sessionId}`),
  };
  if (meta.parentSessionId && (!checkpointRecord || checkpointRecord.inheritedFrom)) {
    const forkWindowId = meta.initialWindowId ?? asWindowId(`fork-${sessionId}`);
    window = { windowNumber: 0, firstWindowId: forkWindowId, windowId: forkWindowId };
  }
  validateLineage(window);

  return {
    sessionId,
    meta,
    history: annotatedHistory.map((item) => structuredClone(item.message)),
    annotatedHistory,
    historyVersion: surviving.filter((record) => record.kind === "message" || record.kind === "compact_checkpoint").length,
    window: structuredClone(window),
    ...(referenceContext ? { referenceContext } : {}),
    ...(worldState ? { worldStateBaseline: worldState } : {}),
    previousTurnSettings: { model: referenceContext?.model ?? meta.model, ...(referenceContext?.compHash ? { compHash: referenceContext.compHash } : {}) },
    ...(checkpointRecord ? { latestCheckpointOrdinal: checkpointRecord.ordinal } : {}),
    incompleteTurnIds: [...activeTurns],
    pendingApprovalRequestIds: [...pendingApprovals],
    unknownOutcomes: [...openCalls.values()],
    lastOrdinal: records.at(-1)?.ordinal ?? -1,
  };
}

function applyRollbacks(records: readonly TranscriptEnvelope[]): TranscriptEnvelope[] {
  const surviving: TranscriptEnvelope[] = [];
  for (const record of records) {
    if (record.kind !== "rollback") {
      surviving.push(record);
      continue;
    }
    const through = (record.payload as RollbackPayload).throughOrdinal;
    if (through >= record.ordinal) throw new Error(`rollback ${record.ordinal} 指向未来 ordinal ${through}`);
    while ((surviving.at(-1)?.ordinal ?? -1) > through) surviving.pop();
    surviving.push(record);
  }
  return surviving;
}

function validateCheckpointChain(records: readonly TranscriptEnvelope[], meta: SessionMetaPayload): void {
  const chainRecords = meta.parentSessionId ? records.filter((record) => !record.inheritedFrom) : records;
  let previous: ContextWindowLineage | undefined;
  for (const record of chainRecords) {
    const window = (record.payload as CompactCheckpointPayload).window;
    validateLineage(window);
    if (!previous) {
      if (meta.initialWindowId && (window.firstWindowId !== meta.initialWindowId || window.previousWindowId !== meta.initialWindowId || window.windowNumber !== 1)) {
        throw new Error(`checkpoint ${record.ordinal} 与初始窗口不连续`);
      }
    } else if (window.firstWindowId !== previous.firstWindowId || window.previousWindowId !== previous.windowId || window.windowNumber !== previous.windowNumber + 1) {
      throw new Error(`checkpoint ${record.ordinal} window lineage 损坏`);
    }
    previous = window;
  }
}

function trackRecovery(
  record: TranscriptEnvelope,
  activeTurns: Set<TurnId>,
  pendingApprovals: Set<string>,
  openCalls: Map<string, UnknownToolOutcome>,
): void {
  switch (record.kind) {
    case "turn_started":
      if (record.turnId) activeTurns.add(record.turnId);
      break;
    case "turn_completed":
    case "turn_aborted":
      if (record.turnId) activeTurns.delete(record.turnId);
      break;
    case "tool_call": {
      const call = record.payload as ToolCallPayload;
      openCalls.set(call.callId, { callId: call.callId, name: call.name, sideEffecting: call.sideEffecting, ...(record.turnId ? { turnId: record.turnId } : {}) });
      break;
    }
    case "tool_result":
      openCalls.delete((record.payload as ToolResultPayload).callId);
      break;
    case "approval_requested":
      pendingApprovals.add((record.payload as { requestId: string }).requestId);
      break;
    case "approval_resolved": {
      const requestId = (record.payload as { requestId?: string }).requestId;
      if (requestId) pendingApprovals.delete(requestId);
      break;
    }
    default:
      break;
  }
}
