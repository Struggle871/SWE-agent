import type { AgentConfig, CompactionConfig } from "../../types.js";

export function resolveCompactionConfig(config: AgentConfig): CompactionConfig {
  const candidate: CompactionConfig = {
    backend: config.compaction?.backend ?? "auto",
    autoCompactTokenLimit: config.compaction?.autoCompactTokenLimit ?? Math.floor(config.maxContextTokens * 0.8),
    limitScope: config.compaction?.limitScope ?? "total",
    fallbackBufferTokens: config.compaction?.fallbackBufferTokens ?? Math.min(512, Math.floor(config.maxContextTokens * 0.1)),
    timeoutMs: config.compaction?.timeoutMs ?? 60_000,
    maxRetries: config.compaction?.maxRetries ?? 2,
    maxRetainedUserTokens: config.compaction?.maxRetainedUserTokens ?? 2_000,
    maxCheckpointItems: config.compaction?.maxCheckpointItems ?? 1_000,
    maxCheckpointBytes: config.compaction?.maxCheckpointBytes ?? 2_000_000,
    maxItemBytes: config.compaction?.maxItemBytes ?? 256_000,
    ...(config.compaction?.prompt ? { prompt: config.compaction.prompt } : {}),
  };
  assertPositiveInteger(candidate.autoCompactTokenLimit, "autoCompactTokenLimit");
  assertNonNegativeInteger(candidate.fallbackBufferTokens, "fallbackBufferTokens");
  assertPositiveInteger(candidate.timeoutMs, "timeoutMs");
  assertNonNegativeInteger(candidate.maxRetries, "maxRetries");
  assertPositiveInteger(candidate.maxRetainedUserTokens, "maxRetainedUserTokens");
  assertPositiveInteger(candidate.maxCheckpointItems, "maxCheckpointItems");
  assertPositiveInteger(candidate.maxCheckpointBytes, "maxCheckpointBytes");
  assertPositiveInteger(candidate.maxItemBytes, "maxItemBytes");
  return {
    ...candidate,
    autoCompactTokenLimit: Math.min(candidate.autoCompactTokenLimit, config.maxContextTokens),
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`compaction.${name} 必须是正整数`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`compaction.${name} 必须是非负整数`);
}
