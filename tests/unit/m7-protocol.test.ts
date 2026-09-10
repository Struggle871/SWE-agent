import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { makeWorkspace } from "../helpers.js";
import { discoverSkills, loadSkillFragments, loadSkillSnapshot, resolveSkillResource, selectSkills } from "../../src/config/skills.js";
import { PromptBuilder } from "../../src/core/prompt-builder.js";

test("native prompt omits JSON/ReAct contract while legacy keeps it", () => {
  const builder = new PromptBuilder();
  const native = builder.systemPrompt([], undefined, undefined, undefined, undefined, true);
  const legacy = builder.systemPrompt([], undefined, undefined, undefined, undefined, false);
  assert.doesNotMatch(native, /JSON|action_input|只能调用一个工具/);
  assert.match(legacy, /action_input/);
});

test("skill discovery isolates invalid files and rejects ambiguous names and oversized bodies", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const base of [".agents", ".codex"]) {
    const dir = path.join(root, base, "skills", "demo");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: demo\ndescription: valid demo\n---\nlarge body", "utf8");
  }
  const invalid = path.join(root, ".agents", "skills", "invalid");
  await fs.mkdir(invalid, { recursive: true });
  await fs.writeFile(path.join(invalid, "SKILL.md"), "missing frontmatter", "utf8");
  const snapshot = loadSkillSnapshot(root);
  assert.equal(snapshot.skills.length, 2);
  assert.equal(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "invalid_skill"), true);
  assert.equal(selectSkills(snapshot, ["demo"]).diagnostics[0]?.code, "skill_name_ambiguous");
  const exact = selectSkills(snapshot, [snapshot.skills[0].canonicalPath], { maxSelectedBodyTokensPerSkill: 1 });
  assert.equal(exact.diagnostics[0]?.code, "skill_body_budget_exceeded");
  assert.throws(() => resolveSkillResource(snapshot.skills[0], "../outside.txt"), /越出/);
});

test("skill enablement is deterministic and catalog never contains the body", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, ".agents", "skills", "demo");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: demo\ndescription: short description\n---\nPRIVATE_BODY", "utf8");
  const disabled = loadSkillSnapshot(root, { enablement: { demo: false } });
  assert.equal(disabled.skills[0].enabled, false);
  assert.equal(loadSkillFragments(root)[0].text.includes("PRIVATE_BODY"), false);
  const before = loadSkillSnapshot(root);
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: demo\ndescription: short description\n---\nCHANGED_BODY", "utf8");
  const after = loadSkillSnapshot(root);
  assert.equal(after.catalogFingerprint, before.catalogFingerprint);
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test("skills use YAML frontmatter and optional openai metadata fails open", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, ".agents", "skills", "demo");
  await fs.mkdir(path.join(dir, "agents"), { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), [
    "---", "name: demo", "description: >", "  Handles a multiline", "  description.",
    "metadata:", "  short-description: Short demo", "---", "PRIVATE_BODY",
  ].join("\n"), "utf8");
  const metadataPath = path.join(dir, "agents", "openai.yaml");
  await fs.writeFile(metadataPath, "policy:\n  allow_implicit_invocation: false\n", "utf8");

  const explicitOnly = loadSkillSnapshot(root);
  assert.equal(explicitOnly.skills[0].description, "Handles a multiline description.");
  assert.equal(explicitOnly.skills[0].shortDescription, "Short demo");
  assert.equal(explicitOnly.skills[0].allowImplicitInvocation, false);
  assert.equal(loadSkillFragments(root).length, 0);
  assert.equal(loadSkillFragments(root, ["demo"]).some((fragment) => fragment.type === "skills.body"), true);

  await fs.writeFile(metadataPath, "policy:\n  allow_implicit_invocation: nope\n", "utf8");
  const failOpen = loadSkillSnapshot(root);
  assert.equal(failOpen.skills.length, 1);
  assert.equal(failOpen.skills[0].allowImplicitInvocation, true);
  assert.equal(failOpen.diagnostics.some((diagnostic) => diagnostic.code === "invalid_skill_metadata"), true);
});

test("explicit admin and system skill roots retain their scopes", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const admin = path.join(root, "host", "admin");
  const system = path.join(root, "host", "system");
  for (const [directory, name] of [[admin, "admin-skill"], [system, "system-skill"]] as const) {
    const skill = path.join(directory, name);
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: scoped skill\n---\nbody`, "utf8");
  }
  const snapshot = loadSkillSnapshot(root, { adminRoots: [admin], systemRoots: [system], includeCodexCompatibilityRoot: false });
  assert.deepEqual(snapshot.skills.map((skill) => skill.scope).sort(), ["admin", "system"]);
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
