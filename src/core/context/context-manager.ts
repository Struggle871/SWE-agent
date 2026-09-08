import type { RequestId, StepId, TurnId } from "../../protocol/ids.js";
import type { Usage } from "../../protocol/usage.js";
import type { Message } from "../../types.js";
import { ContextWindowState } from "./context-window.js";
import { canonicalizeEnvelope, envelope, turnIds } from "./compaction-history.js";
import type {
  CompactCheckpointPayload,
  ContextItemEnvelope,
  ContextItemMetadata,
  ContextWindowLineage,
  ReferenceContextPayload,
  WorldStatePayload,
} from "./compaction-types.js";
import { estimateModelMessageTokens } from "./token-accounting.js";
import { applyWorldState } from "./world-state.js";

export interface RestoredContextState {
  items: ContextItemEnvelope[];
  window: ContextWindowLineage;
  referenceContext?: ReferenceContextPayload;
  worldState?: WorldStatePayload;
  prefillTokens?: number;
  latestCheckpointOrdinal?: number;
  historyVersion?: number;
}

export class ContextManager {
  readonly window: ContextWindowState;
  private items: ContextItemEnvelope[];
  private reference: ReferenceContextPayload | undefined;
  private world: WorldStatePayload | undefined;
  private version = 0;
  private checkpointOrdinal: number | undefined;

  constructor(restored?: RestoredContextState) {
    this.items = (restored?.items ?? []).map(canonicalizeEnvelope);
    this.window = new ContextWindowState(restored?.window, restored?.prefillTokens);
    this.reference = structuredClone(restored?.referenceContext);
    this.world = structuredClone(restored?.worldState);
    this.checkpointOrdinal = restored?.latestCheckpointOrdinal;
    this.version = restored?.historyVersion ?? this.items.length;
  }

  historyVersion(): number { return this.version; }
  messages(): Message[] { return this.items.map((item) => structuredClone(item.message)); }
  annotatedItems(): ContextItemEnvelope[] { return structuredClone(this.items); }
  referenceContext(): ReferenceContextPayload | undefined { return structuredClone(this.reference); }
  worldState(): WorldStatePayload | undefined { return structuredClone(this.world); }
  latestCheckpointOrdinal(): number | undefined { return this.checkpointOrdinal; }
  sourceTurnIds(): TurnId[] { return turnIds(this.items); }

  prepareMessage(
    message: Message,
    context: { turnId?: TurnId; stepId?: StepId; kind?: ContextItemMetadata["kind"]; usageAnchor?: ContextItemMetadata["usageAnchor"] } = {},
  ): ContextItemEnvelope {
    return envelope(message, {
      kind: context.kind ?? "conversation",
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...(context.stepId ? { stepId: context.stepId } : {}),
      ...(context.usageAnchor ? { usageAnchor: context.usageAnchor } : {}),
    });
  }

  recordPersisted(item: ContextItemEnvelope): void {
    this.items.push(canonicalizeEnvelope(item));
    this.version += 1;
    const usage = item.message.usage;
    if (usage) this.window.observeUsage(usage);
  }

  installCheckpoint(checkpoint: CompactCheckpointPayload, ordinal: number): void {
    this.window.commit(checkpoint.window);
    this.items = structuredClone(checkpoint.replacementHistory);
    this.reference = undefined;
    this.world = undefined;
    this.version += 1;
    this.checkpointOrdinal = ordinal;
  }

  setReference(reference: ReferenceContextPayload | undefined): void {
    this.reference = reference?.cleared ? undefined : structuredClone(reference);
  }

  applyWorldState(update: WorldStatePayload): void {
    this.world = applyWorldState(this.world, update);
  }

  restore(restored: RestoredContextState): void {
    this.items = structuredClone(restored.items);
    this.window.restore(restored.window, restored.prefillTokens);
    this.reference = structuredClone(restored.referenceContext);
    this.world = structuredClone(restored.worldState);
    this.checkpointOrdinal = restored.latestCheckpointOrdinal;
    this.version += 1;
  }

  anchoredTokenCount(requestFingerprint: string): { tokens: number; estimated: boolean } | undefined {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      const item = this.items[index];
      const anchor = item.metadata.usageAnchor;
      const usage = item.message.usage;
      if (!anchor || !usage || anchor.windowId !== this.window.snapshot().windowId || anchor.requestFingerprint !== requestFingerprint) continue;
      const suffixItems = this.items.slice(index + 1);
      const suffixTokens = suffixItems.reduce((sum, candidate) => sum + estimateModelMessageTokens(candidate.message), 0);
      return {
        tokens: usage.totalTokens + suffixTokens,
        estimated: !anchor.observed || suffixItems.length > 0,
      };
    }
    return undefined;
  }

  usageAnchor(
    requestId: RequestId,
    requestHistoryVersion: number,
    requestFingerprint: string,
    observed: boolean,
  ): ContextItemMetadata["usageAnchor"] {
    return { requestId, requestHistoryVersion, requestFingerprint, windowId: this.window.snapshot().windowId, observed };
  }

  observeUsage(usage: Usage): void { this.window.observeUsage(usage); }
}
