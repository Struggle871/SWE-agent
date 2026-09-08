import { createWindowId, type WindowId } from "../../protocol/ids.js";
import type { Usage } from "../../protocol/usage.js";
import type { AgentConfig } from "../../types.js";
import { resolveCompactionConfig } from "./compaction-config.js";
import type { ContextWindowLineage, TokenStatus } from "./compaction-types.js";

export class ContextWindowState {
  private lineage: ContextWindowLineage;
  private prefillTokens: number | undefined;
  private readonly attempts = new Set<string>();

  constructor(lineage?: ContextWindowLineage, prefillTokens?: number) {
    const initial = createWindowId();
    this.lineage = structuredClone(lineage ?? {
      windowNumber: 0,
      firstWindowId: initial,
      windowId: initial,
    });
    this.prefillTokens = validTokens(prefillTokens);
  }

  snapshot(): ContextWindowLineage {
    return structuredClone(this.lineage);
  }

  next(): ContextWindowLineage {
    return {
      windowNumber: this.lineage.windowNumber + 1,
      firstWindowId: this.lineage.firstWindowId,
      previousWindowId: this.lineage.windowId,
      windowId: createWindowId(),
    };
  }

  commit(next: ContextWindowLineage): void {
    if (next.windowNumber !== this.lineage.windowNumber + 1 || next.firstWindowId !== this.lineage.firstWindowId || next.previousWindowId !== this.lineage.windowId) {
      throw new Error("context window lineage 无法从当前窗口推进");
    }
    this.lineage = structuredClone(next);
    this.prefillTokens = undefined;
    this.attempts.clear();
  }

  restore(lineage: ContextWindowLineage, prefillTokens?: number): void {
    validateLineage(lineage);
    this.lineage = structuredClone(lineage);
    this.prefillTokens = validTokens(prefillTokens);
    this.attempts.clear();
  }

  tokenStatus(estimatedInputTokens: number, config: AgentConfig, estimated = true): TokenStatus {
    const compact = resolveCompactionConfig(config);
    const input = Math.max(0, Math.ceil(estimatedInputTokens));
    const scopeTokens = compact.limitScope === "body_after_prefix"
      ? Math.max(0, input - (this.prefillTokens ?? 0))
      : input;
    return {
      estimatedInputTokens: input,
      reservedOutputTokens: config.maxOutputTokens,
      hardLimit: config.maxContextTokens,
      autoCompactLimit: compact.autoCompactTokenLimit,
      scope: compact.limitScope,
      ...(this.prefillTokens === undefined ? {} : { prefillTokens: this.prefillTokens }),
      scopeTokens,
      hardLimitReached: input + config.maxOutputTokens + compact.fallbackBufferTokens >= config.maxContextTokens,
      autoCompactLimitReached: scopeTokens >= compact.autoCompactTokenLimit,
      estimated,
    };
  }

  observeUsage(usage: Usage): void {
    if (this.prefillTokens === undefined) this.prefillTokens = Math.max(0, usage.inputTokens);
  }

  setEstimatedPrefill(tokens: number): void {
    if (this.prefillTokens === undefined) this.prefillTokens = Math.max(0, Math.ceil(tokens));
  }

  claimAttempt(reason: string, phase: string): boolean {
    const key = `${this.lineage.windowId}:${reason}:${phase}`;
    if (this.attempts.has(key)) return false;
    this.attempts.add(key);
    return true;
  }
}

export function validateLineage(lineage: ContextWindowLineage): void {
  if (!Number.isInteger(lineage.windowNumber) || lineage.windowNumber < 0) throw new Error("windowNumber 无效");
  if (!lineage.firstWindowId || !lineage.windowId) throw new Error("context window id 缺失");
  if (lineage.windowNumber === 0 && lineage.previousWindowId) throw new Error("初始窗口不能有 previousWindowId");
  if (lineage.windowNumber > 0 && !lineage.previousWindowId) throw new Error("非初始窗口必须有 previousWindowId");
}

export function initialLineage(windowId: WindowId): ContextWindowLineage {
  return { windowNumber: 0, firstWindowId: windowId, windowId };
}

function validTokens(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined;
}
