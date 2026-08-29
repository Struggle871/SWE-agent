import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FileStateCache } from "../../src/core/file-state-cache.js";
import { makeWorkspace } from "../helpers.js";

test("detects content changes even when timestamp is restored", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.txt");
  await fs.writeFile(file, "before", "utf8");
  const cache = new FileStateCache();
  await cache.markRead(file);
  const original = await fs.stat(file);
  await fs.writeFile(file, "after!", "utf8");
  await fs.utimes(file, original.atime, original.mtime);
  assert.match(await cache.assertFresh(file) ?? "", /已被修改/);
  assert.equal(cache.get(file)?.contentHash.length, 64);
});
