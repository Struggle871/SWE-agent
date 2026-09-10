import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../../src/core/memory-store.js";
import { Executor } from "../../src/core/executor.js";
import { memoryConsolidateTool, memoryDeleteTool, memoryExtractTool, memoryPutTool, memorySearchTool } from "../../src/tools/memory-tools.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";

test("memory tools persist provenance, retrieve and tombstone through ToolRouter", async () => {
  const root = await makeWorkspace();
  const ctx = await makeContext(root);
  const store = new MemoryStore(path.join(root, "state", "memory.sqlite"));
  ctx.memoryStore = store;
  for (const tool of [memoryPutTool, memorySearchTool, memoryDeleteTool, memoryExtractTool, memoryConsolidateTool]) ctx.registry.register(tool);
  const executor = new Executor();
  try {
    const put = await executor.execute({ type: "tool_call", toolName: "memory_put", toolInput: { kind: "project", content: "uses strict TypeScript", provenance: "AGENTS.md", confidence: 0.9 } }, ctx);
    const id = (JSON.parse(put.output) as { id: string }).id;
    const found = await executor.execute({ type: "tool_call", toolName: "memory_search", toolInput: { query: "STRICT" } }, ctx);
    assert.equal((JSON.parse(found.output) as unknown[]).length, 1);
    await executor.execute({ type: "tool_call", toolName: "memory_delete", toolInput: { id } }, ctx);
    assert.deepEqual(store.search("strict"), []);
    const extracted = await executor.execute({ type: "tool_call", toolName: "memory_extract", toolInput: { kind: "project", text: "Uses strict TypeScript.\nTests run with npm run check.", provenance: "interview", confidence: 0.8 } }, ctx);
    assert.equal(extracted.isError, undefined);
    assert.equal(store.candidates("pending").length, 2);
    const consolidated = await executor.execute({ type: "tool_call", toolName: "memory_consolidate", toolInput: {} }, ctx);
    assert.equal(consolidated.isError, undefined);
    assert.equal(store.search("npm run check").length, 1);
    assert.throws(() => store.upsert({ kind: "user", content: "x", provenance: "test", confidence: 2 }), /0\.\.1/);
  } finally { store.close(); await cleanupContext(ctx); }
});
