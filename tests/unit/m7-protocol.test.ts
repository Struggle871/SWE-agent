import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { makeWorkspace } from "../helpers.js";
import { discoverSkills, loadSkillFragments } from "../../src/config/skills.js";
import { PromptBuilder } from "../../src/core/prompt-builder.js";

test("native prompt omits JSON/ReAct contract while legacy keeps it", () => {
  const builder = new PromptBuilder();
  const native = builder.systemPrompt([], undefined, undefined, undefined, undefined, true);
  const legacy = builder.systemPrompt([], undefined, undefined, undefined, undefined, false);
  assert.doesNotMatch(native, /JSON|action_input|只能调用一个工具/);
  assert.match(legacy, /action_input/);
});

test("skills discovery keeps catalog separate from selected bodies", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, ".agents", "skills", "demo");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: demo\ndescription: demo skill\n---\nbody", "utf8");
  assert.equal(discoverSkills(root).length, 1);
  assert.equal(loadSkillFragments(root).filter((fragment) => fragment.type === "skills.body").length, 0);
  assert.equal(loadSkillFragments(root, ["demo"]).filter((fragment) => fragment.type === "skills.body").length, 1);
});
