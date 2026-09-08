import { createHash } from "node:crypto";
import type { ModelMessage, ModelToolDefinition } from "../../protocol/model-events.js";
import { estimateTextTokens } from "./token-estimator.js";

export interface ModelRequestProjection {
  messages: readonly ModelMessage[];
  tools?: readonly ModelToolDefinition[];
  maxOutputTokens: number;
  model: string;
}

export function estimateModelRequestInputTokens(request: ModelRequestProjection): number {
  let total = 3;
  for (const message of request.messages) {
    total += estimateModelMessageTokens(message);
  }
  if (request.tools) total += estimateTextTokens(stableStringify(request.tools));
  return total;
}

export function estimateModelMessageTokens(message: ModelMessage): number {
  let total = 4 + estimateTextTokens(message.role) + estimateTextTokens(message.content);
  if (message.name) total += estimateTextTokens(message.name);
  if (message.toolCallId) total += estimateTextTokens(message.toolCallId);
  if (message.toolCalls) total += estimateTextTokens(stableStringify(message.toolCalls));
  return total;
}

export function requestFingerprint(request: ModelRequestProjection): string {
  return sha256(stableStringify({ model: request.model, tools: request.tools ?? [], maxOutputTokens: request.maxOutputTokens }));
}

export function fingerprint(value: unknown): string {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
