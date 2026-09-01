export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
}

export function normalizeUsage(value: Partial<Usage> | undefined): Usage | undefined {
  if (!value) return undefined;
  const inputTokens = nonNegative(value.inputTokens);
  const outputTokens = nonNegative(value.outputTokens);
  const totalTokens = nonNegative(value.totalTokens || inputTokens + outputTokens);
  const cachedInputTokens = value.cachedInputTokens === undefined
    ? undefined
    : nonNegative(value.cachedInputTokens);
  return { inputTokens, outputTokens, totalTokens, ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }) };
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
