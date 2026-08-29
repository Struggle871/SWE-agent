import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { WorkspacePolicy } from "../../src/security/workspace-policy.js";
import { makeWorkspace } from "../helpers.js";

test("resolves canonical paths and rejects lexical escapes and protected paths", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const policy = await WorkspacePolicy.create({ readableRoots: [root] });
  await assert.rejects(policy.resolve("../outside.txt", "read"), /越出/);
  await assert.rejects(policy.resolve("file.txt:secret", "read"), /alternate data stream/);
  const protectedTarget = await policy.resolve(".git/config", "write");
  assert.throws(() => policy.assertWritableTarget(protectedTarget), /受保护/);
  if (process.platform === "win32") {
    const differentlyCased = root.toUpperCase();
    assert.ok((await policy.resolve(differentlyCased, "read")).canonicalPath);
  }
});

test("rejects existing and new targets traversing an external directory link", async (t) => {
  const root = await makeWorkspace();
  const outside = await makeWorkspace();
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.writeFile(path.join(outside, "outside.txt"), "secret", "utf8");
  const link = path.join(root, "link");
  try {
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`当前环境不能创建目录链接: ${String(error)}`);
    return;
  }
  const policy = await WorkspacePolicy.create({ readableRoots: [root] });
  await assert.rejects(policy.resolve("link/outside.txt", "read"), /越出/);
  await assert.rejects(policy.resolve("link/new.txt", "write"), /越出/);
});
