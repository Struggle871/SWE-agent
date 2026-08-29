import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Executor } from "../../src/core/executor.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";

test("edit_file requires a read and rejects ambiguous replacements", async (t) => {
  const root = await makeWorkspace();
  const ctx = await makeContext(root);
  t.after(() => cleanupContext(ctx));
  const file = path.join(root, "edit.txt");
  await fs.writeFile(file, "same\nsame\n", "utf8");
  const executor = new Executor();
  const unread = await executor.execute({
    type: "tool_call", toolName: "edit_file", toolInput: { path: "edit.txt", old_string: "same", new_string: "next" },
  }, ctx);
  assert.equal(unread.isError, true);
  assert.match(unread.output, /尚未读取/);
  await executor.execute({ type: "tool_call", toolName: "read_file", toolInput: { path: "edit.txt" } }, ctx);
  const ambiguous = await executor.execute({
    type: "tool_call", toolName: "edit_file", toolInput: { path: "edit.txt", old_string: "same", new_string: "next" },
  }, ctx);
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.output, /不唯一/);
});

test("detects external changes before editing", async (t) => {
  const root = await makeWorkspace();
  const ctx = await makeContext(root);
  t.after(() => cleanupContext(ctx));
  const file = path.join(root, "edit.txt");
  await fs.writeFile(file, "old", "utf8");
  const executor = new Executor();
  await executor.execute({ type: "tool_call", toolName: "read_file", toolInput: { path: "edit.txt" } }, ctx);
  await fs.writeFile(file, "external", "utf8");
  const result = await executor.execute({
    type: "tool_call", toolName: "edit_file", toolInput: { path: "edit.txt", old_string: "old", new_string: "new" },
  }, ctx);
  assert.equal(result.isError, true);
  assert.equal(await fs.readFile(file, "utf8"), "external");
});
