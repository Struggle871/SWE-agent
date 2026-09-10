import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { discoverAgentMemories, instructionFragments, loadAgentMemories, loadInstructionSnapshot } from "../../src/config/agents-md.js";
import { configExplain, loadConfigLayerStack } from "../../src/config/layered-config.js";
import { ScopedContextFileSystem, type ContextFileSystem } from "../../src/config/context-filesystem.js";
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

test("strict TOML rejects malformed and duplicate values", () => {
  assert.deepEqual(parseToml('items = [1, "two", { enabled = true }]'), { items: [1, "two", { enabled: true }] });
  assert.throws(() => parseToml("value = 1\nvalue = 2"), /TOML 解析失败/);
  assert.throws(() => parseToml("value = null"), /TOML 解析失败/);
  assert.throws(() => parseToml("value = [1, 2"), /TOML 解析失败/);
  const complete = parseToml('title = """line one\nline two"""\nwhen = 1979-05-27T07:32:00Z\n[owner.profile]\nname = "demo"');
  assert.equal(complete.title, "line one\nline two");
  assert.deepEqual(complete.owner, { profile: { name: "demo" } });
  assert.ok(complete.when);
});

test("config layers merge root-to-cwd with leaf provenance and redact secrets", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".git"));
  await fs.mkdir(path.join(root, ".swe-agent"));
  await fs.writeFile(path.join(root, ".swe-agent", "config.toml"), "max_steps = 4\n[model]\nmodel = 'root-model'\napi_key = 'secret'\n", "utf8");
  const nested = path.join(root, "packages", "app");
  await fs.mkdir(path.join(nested, ".swe-agent"), { recursive: true });
  await fs.writeFile(path.join(nested, ".swe-agent", "config.toml"), "max_output_tokens = 99\n", "utf8");
  const stack = loadConfigLayerStack({ parseRetry: 7 }, { cwd: nested, env: {}, userConfigPath: null });
  assert.equal(stack.effective.maxSteps, 4);
  assert.equal(stack.effective.maxOutputTokens, 99);
  assert.equal(stack.effective.parseRetry, 7);
  assert.match(stack.origins.get("model.model")?.layerId ?? "", /^project:/);
  assert.equal(configExplain(stack, "model.apiKey").value, "<redacted>");
  assert.deepEqual(configExplain(stack, "maxSteps").history.map((entry) => entry.value), [20, 4]);
});

test("untrusted project config is retained as disabled and managed requirements cannot be relaxed", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".git"));
  await fs.mkdir(path.join(root, ".swe-agent"));
  await fs.writeFile(path.join(root, ".swe-agent", "config.toml"), "max_steps = 1\n", "utf8");
  const untrusted = loadConfigLayerStack({}, { cwd: root, env: {}, userConfigPath: null, projectTrusted: false });
  assert.equal(untrusted.effective.maxSteps, 20);
  assert.equal(untrusted.layers.find((layer) => layer.kind === "project")?.disabledReason, "untrusted_project");

  const requirements = path.join(root, "requirements.toml");
  await fs.writeFile(requirements, "[requirements]\nallowed_sandbox_modes = ['docker']\nnetwork_ceiling = 'deny'\n", "utf8");
  assert.throws(() => loadConfigLayerStack({ sandboxMode: "best-effort" }, {
    cwd: root, env: {}, userConfigPath: null, requirementsPath: requirements,
  }), /managed requirement/);
  assert.throws(() => loadConfigLayerStack({ sandboxMode: "docker", networkAccess: "allow" }, {
    cwd: root, env: {}, userConfigPath: null, requirementsPath: requirements,
  }), /networkAccess/);
});

test("untrusted project config is discovered without reading its contents", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".git"));
  await fs.mkdir(path.join(root, ".swe-agent"));
  await fs.writeFile(path.join(root, ".swe-agent", "config.toml"), "model = { api_key = 'must-not-be-read' }", "utf8");
  const base = new ScopedContextFileSystem([root]);
  let contentReads = 0;
  const fileSystem: ContextFileSystem = {
    exists: (candidate) => base.exists(candidate),
    isFile: (candidate) => base.isFile(candidate),
    isDirectory: (candidate) => base.isDirectory(candidate),
    readBytes: (candidate) => { contentReads += 1; return base.readBytes(candidate); },
    readText: (candidate) => { contentReads += 1; return base.readText(candidate); },
    readDirectory: (candidate) => base.readDirectory(candidate),
    realpath: (candidate) => base.realpath(candidate),
  };
  const stack = loadConfigLayerStack({}, { cwd: root, env: {}, userConfigPath: null, projectTrusted: false, fileSystem });
  assert.equal(stack.layers.some((layer) => layer.kind === "project" && layer.disabledReason === "untrusted_project"), true);
  assert.equal(contentReads, 0);
});

test("optional system, enterprise, user, and profile layers preserve declared priority", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".git"));
  await fs.mkdir(path.join(root, ".swe-agent"));
  const files = {
    system: path.join(root, "system.toml"), enterprise: path.join(root, "enterprise.toml"),
    user: path.join(root, "user.toml"), profile: path.join(root, "profile.toml"),
  };
  await Promise.all([
    fs.writeFile(files.system, "max_steps = 21", "utf8"),
    fs.writeFile(files.enterprise, "max_steps = 22", "utf8"),
    fs.writeFile(files.user, "max_steps = 23", "utf8"),
    fs.writeFile(files.profile, "max_steps = 24", "utf8"),
    fs.writeFile(path.join(root, ".swe-agent", "config.toml"), "max_steps = 25", "utf8"),
  ]);
  const stack = loadConfigLayerStack({ maxSteps: 27 }, {
    cwd: root, env: { MAX_STEPS: "26" }, userConfigPath: files.user,
    systemConfigPath: files.system, enterpriseConfigPath: files.enterprise, profileConfigPath: files.profile,
  });
  assert.deepEqual(stack.layers.map((layer) => layer.kind), [
    "packaged_defaults", "system", "enterprise_managed", "user", "profile", "project", "env_compat", "session_flags",
  ]);
  assert.equal(stack.effective.maxSteps, 27);
});

test("AGENTS selects one file per directory, honors trust, byte budgets, and removals", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "AGENTS.md"), "base", "utf8");
  await fs.writeFile(path.join(root, "AGENTS.override.md"), "override", "utf8");
  const nested = path.join(root, "src");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, "CLAUDE.md"), "fallback", "utf8");
  assert.deepEqual(discoverAgentMemories(nested), [path.join(root, "AGENTS.override.md")]);
  const withFallback = loadInstructionSnapshot({ cwd: nested, fallbackFilenames: ["CLAUDE.md"] });
  assert.deepEqual(withFallback.entries.map((entry) => entry.content), ["override", "fallback"]);
  assert.equal(loadInstructionSnapshot({ cwd: nested, trusted: false }).entries.length, 0);
  await fs.writeFile(path.join(root, "AGENTS.override.md"), "你好", "utf8");
  const bounded = loadInstructionSnapshot({ cwd: root, budgetBytes: 5 });
  assert.equal(bounded.totalBytes, 5);
  assert.equal(bounded.entries[0].truncated, true);
  const removed = instructionFragments(loadInstructionSnapshot({ cwd: root, trusted: false }), bounded);
  assert.equal(removed.some((fragment) => fragment.type === "agents_md.removal"), true);
});

test("context filesystem rejects reads outside its canonical roots", async (t) => {
  const root = await makeWorkspace();
  const outside = await makeWorkspace();
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const insideFile = path.join(root, "inside.txt");
  const outsideFile = path.join(outside, "outside.txt");
  await fs.writeFile(insideFile, "inside", "utf8");
  await fs.writeFile(outsideFile, "outside", "utf8");
  const io = new ScopedContextFileSystem([root]);
  assert.equal(io.readText(insideFile), "inside");
  assert.throws(() => io.readText(outsideFile), /越出允许根目录/);
});
