import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CompactionPipeline } from "../../src/core/context/compaction-pipeline.js";
import { ToolResultStorage } from "../../src/core/context/tool-result-storage.js";
import { makeWorkspace } from "../helpers.js";

test("persists large tool results and returns a bounded preview", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = new ToolResultStorage(path.join(root, "session"), 10, 5);
  const result = await new CompactionPipeline(storage).compact([
    { role: "user", content: "task" }, { role: "tool", name: "x", content: "0123456789abcdef" },
  ], { budgetTokens: 100 });
  assert.equal(result.report.persistedToolResults, 1);
  assert.match(result.messages[1].content, /Full output saved/);
  assert.equal(await fs.readFile(path.join(root, "session", "tool-results", "message-1.txt"), "utf8"), "0123456789abcdef");
});
