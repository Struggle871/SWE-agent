import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { discoverAgentMemories, loadAgentMemories } from "../../src/config/agents-md.js";
import { parseToml } from "../../src/config/toml.js";
import { makeWorkspace } from "../helpers.js";

test("parses configuration and discovers project instructions", async (t) => {
  assert.deepEqual(parseToml('max_steps = 4\n[model]\nmodel = "demo"'), { max_steps: 4, model: { model: "demo" } });
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "AGENTS.md"), "strict rules", "utf8");
  const nested = path.join(root, "src");
  await fs.mkdir(nested);
  assert.deepEqual(discoverAgentMemories(nested), [path.join(root, "AGENTS.md")]);
  assert.match(loadAgentMemories(nested), /strict rules/);
});
