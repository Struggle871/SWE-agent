import { randomUUID } from "node:crypto";
import type { TurnId } from "../../protocol/ids.js";
import type { Message } from "../../types.js";
import { messageTokenCount } from "./token-estimator.js";
import type { ContextItemEnvelope, ContextItemMetadata } from "./compaction-types.js";
import type { ResponseItem } from "../../protocol/items.js";

export function envelope(message: Message, metadata: ContextItemMetadata, id: string = randomUUID()): ContextItemEnvelope {
  return { id, item: messageToResponseItem(message, id, metadata), message: structuredClone(message), metadata: structuredClone(metadata) };
}

export function canonicalizeEnvelope(item: ContextItemEnvelope): ContextItemEnvelope {
  if (item.item) return structuredClone(item);
  return envelope(item.message, item.metadata, item.id);
}

function messageToResponseItem(message: Message, id: string, metadata: ContextItemMetadata): ResponseItem {
  const turnId = metadata.turnId;
  if (message.role === "user") return { kind: "user_text", id, text: message.content, ...(turnId ? { turnId } : {}) };
  if (message.role === "assistant" && message.toolCalls?.length === 1) return { kind: "tool_call", id: message.toolCalls[0].callId, name: message.toolCalls[0].name, input: message.toolCalls[0].input, ...(turnId ? { turnId } : {}) };
  if (message.role === "assistant" && message.toolCalls?.length) return { kind: "tool_calls", id, calls: message.toolCalls.map((call) => ({ callId: call.callId, name: call.name, input: call.input })), ...(turnId ? { turnId } : {}), ...(metadata.stepId ? { stepId: metadata.stepId } : {}) };
  if (message.role === "assistant") return { kind: "assistant_text", id, text: message.content, ...(turnId ? { turnId } : {}), ...(metadata.stepId ? { stepId: metadata.stepId } : {}), ...(message.usage ? { usage: message.usage } : {}) };
  if (message.role === "tool" && message.toolCallId) return { kind: "tool_result", id, callId: message.toolCallId, name: message.name ?? "tool", output: { status: "ok", text: message.content, truncated: false }, ...(turnId ? { turnId } : {}) };
  return { kind: "context_injection", id, source: metadata.kind, text: message.content };
}

export function retainLocalUserHistory(items: readonly ContextItemEnvelope[], maxTokens: number): ContextItemEnvelope[] {
  const users = items.filter((item) => item.message.role === "user" && item.metadata.kind === "conversation");
  const retained: ContextItemEnvelope[] = [];
  let used = 0;
  for (let index = users.length - 1; index >= 0; index -= 1) {
    const item = structuredClone(users[index]);
    const tokens = messageTokenCount(item.message);
    if (used + tokens <= maxTokens) {
      retained.unshift(item);
      used += tokens;
      continue;
    }
    const remaining = maxTokens - used;
    if (remaining > 8) {
      item.message.content = truncateTextToTokens(item.message.content, remaining - 4);
      retained.unshift(item);
    }
    break;
  }
  return retained;
}

export function insertInitialContext(items: ContextItemEnvelope[], initialContext: ContextItemEnvelope): ContextItemEnvelope[] {
  const result = structuredClone(items);
  let index = -1;
  for (let cursor = result.length - 1; cursor >= 0; cursor -= 1) {
    if (result[cursor].message.role === "user" && result[cursor].metadata.kind === "conversation") {
      index = cursor;
      break;
    }
  }
  if (index < 0) index = Math.max(0, result.length - 1);
  result.splice(index, 0, structuredClone(initialContext));
  return result;
}

export function normalizeCallPairs(items: readonly ContextItemEnvelope[]): ContextItemEnvelope[] {
  const callIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const item of items) {
    for (const call of item.message.toolCalls ?? []) callIds.add(call.callId);
    if (item.message.toolCallId) outputIds.add(item.message.toolCallId);
  }
  return items.filter((item) => {
    const calls = item.message.toolCalls ?? [];
    if (calls.length > 0 && calls.some((call) => !outputIds.has(call.callId))) return false;
    if (item.message.toolCallId && !callIds.has(item.message.toolCallId)) return false;
    return true;
  }).map((item) => structuredClone(item));
}

export function removeOldestItemGroup(items: readonly ContextItemEnvelope[]): ContextItemEnvelope[] {
  if (items.length === 0) return [];
  const first = items[0];
  const ids = new Set((first.message.toolCalls ?? []).map((call) => call.callId));
  if (first.message.toolCallId) ids.add(first.message.toolCallId);
  return items.slice(1).filter((item) => {
    if (item.message.toolCallId && ids.has(item.message.toolCallId)) return false;
    if ((item.message.toolCalls ?? []).some((call) => ids.has(call.callId))) return false;
    return true;
  }).map((item) => structuredClone(item));
}

export function turnIds(items: readonly ContextItemEnvelope[]): TurnId[] {
  return [...new Set(items.flatMap((item) => item.metadata.turnId ? [item.metadata.turnId] : []))];
}

function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate: Message = { role: "user", content: text.slice(text.length - middle) };
    if (messageTokenCount(candidate) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(text.length - low);
}
