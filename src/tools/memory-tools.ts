import type { MemoryKind } from "../core/memory-store.js";
import type { Tool } from "./types.js";

const kinds = ["user", "feedback", "project", "reference"];
export const memoryPutTool: Tool = {
  name: "memory_put", description: "保存带来源和置信度的长期记忆。", isReadOnly: false,
  parameters: { type: "object", properties: { id: { type: "string" }, kind: { type: "string", enum: kinds }, content: { type: "string" }, provenance: { type: "string" }, confidence: { type: "number" } }, required: ["kind", "content", "provenance", "confidence"], additionalProperties: false },
  async execute(input, ctx) {
    if (!ctx.memoryStore) return { toolName: "memory_put", output: "Memory store 未启用", isError: true };
    return { toolName: "memory_put", output: JSON.stringify(ctx.memoryStore.upsert({ ...(typeof input.id === "string" ? { id: input.id } : {}), kind: input.kind as MemoryKind, content: String(input.content), provenance: String(input.provenance), confidence: Number(input.confidence) })) };
  },
};
export const memorySearchTool: Tool = {
  name: "memory_search", description: "按词项和可选类别检索长期记忆。", isReadOnly: true,
  parameters: { type: "object", properties: { query: { type: "string" }, kind: { type: "string", enum: kinds } }, required: ["query"], additionalProperties: false },
  async execute(input, ctx) { return { toolName: "memory_search", output: JSON.stringify(ctx.memoryStore?.search(String(input.query), typeof input.kind === "string" ? input.kind as MemoryKind : undefined) ?? []) }; },
};
export const memoryDeleteTool: Tool = {
  name: "memory_delete", description: "以 tombstone 删除长期记忆，保留审计来源。", isReadOnly: false,
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  async execute(input, ctx) { if (!ctx.memoryStore) return { toolName: "memory_delete", output: "Memory store 未启用", isError: true }; ctx.memoryStore.delete(String(input.id)); return { toolName: "memory_delete", output: "deleted" }; },
};
export const memoryExtractTool: Tool = {
  name: "memory_extract", description: "从文本生成待审查的长期记忆候选，不直接污染正式记忆。", isReadOnly: false,
  parameters: { type: "object", properties: { text: { type: "string" }, kind: { type: "string", enum: kinds }, provenance: { type: "string" }, confidence: { type: "number" } }, required: ["text", "kind", "provenance"], additionalProperties: false },
  async execute(input, ctx) { if (!ctx.memoryStore) return { toolName: "memory_extract", output: "Memory store 未启用", isError: true }; return { toolName: "memory_extract", output: JSON.stringify(ctx.memoryStore.extract({ text: String(input.text), kind: input.kind as MemoryKind, provenance: String(input.provenance), ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {}) })) }; },
};
export const memoryConsolidateTool: Tool = {
  name: "memory_consolidate", description: "审查待处理候选，去重、拒绝低置信度项并写入正式长期记忆。", isReadOnly: false,
  parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  async execute(input, ctx) { if (!ctx.memoryStore) return { toolName: "memory_consolidate", output: "Memory store 未启用", isError: true }; return { toolName: "memory_consolidate", output: JSON.stringify(ctx.memoryStore.consolidate(Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string") : undefined)) }; },
};
export const memoryCandidatesTool: Tool = {
  name: "memory_candidates", description: "列出尚未合并的记忆候选及其来源与置信度。", isReadOnly: true,
  parameters: { type: "object", properties: { status: { type: "string", enum: ["pending", "accepted", "duplicate", "rejected"] } }, additionalProperties: false },
  async execute(input, ctx) { return { toolName: "memory_candidates", output: JSON.stringify(ctx.memoryStore?.candidates(typeof input.status === "string" ? input.status as never : undefined) ?? []) }; },
};
