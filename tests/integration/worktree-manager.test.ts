import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeManager } from "../../src/core/worktree-manager.js";
import { makeWorkspace } from "../helpers.js";

const run = promisify(execFile);

test("managed worktree creates an isolated checkout and removes it", async (t) => {
  const root = await makeWorkspace();
  const managedRoot = await makeWorkspace();
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(managedRoot, { recursive: true, force: true })]));
  await run("git", ["init", root]);
  await run("git", ["-C", root, "config", "user.email", "tests@example.invalid"]);
  await run("git", ["-C", root, "config", "user.name", "Tests"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "base", "utf8");
  await run("git", ["-C", root, "add", "tracked.txt"]);
  await run("git", ["-C", root, "commit", "-m", "base"]);
  const manager = new WorktreeManager(managedRoot);
  const worktree = await manager.create(root);
  assert.equal(await fs.readFile(path.join(worktree.root, "tracked.txt"), "utf8"), "base");
  await fs.writeFile(path.join(worktree.root, "tracked.txt"), "child", "utf8");
  assert.equal(await fs.readFile(path.join(root, "tracked.txt"), "utf8"), "base");
  await manager.remove(worktree);
  await assert.rejects(() => fs.stat(worktree.root), /ENOENT/);
});

test("worktree conflicts ignore ownership metadata and detect only shared changed paths", async (t) => {
  const root = await makeWorkspace(); const managedRoot = await makeWorkspace();
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(managedRoot, { recursive: true, force: true })]));
  await run("git", ["init", root]); await run("git", ["-C", root, "config", "user.email", "tests@example.invalid"]); await run("git", ["-C", root, "config", "user.name", "Tests"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "base", "utf8"); await run("git", ["-C", root, "add", "tracked.txt"]); await run("git", ["-C", root, "commit", "-m", "base"]);
  const manager = new WorktreeManager(managedRoot); const left = await manager.create(root); const right = await manager.create(root);
  try {
    assert.deepEqual(await manager.conflicts(left, right), []);
    await fs.writeFile(path.join(left.root, "tracked.txt"), "left", "utf8"); await fs.writeFile(path.join(right.root, "tracked.txt"), "right", "utf8");
    assert.deepEqual(await manager.conflicts(left, right), ["tracked.txt"]);
  } finally { await manager.remove(left); await manager.remove(right); }
});
