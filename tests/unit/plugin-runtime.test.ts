import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PluginLifecycleManager } from "../../src/skills/plugin-manager.js";
import { PluginActivationManager } from "../../src/skills/plugin-activation.js";
import { LocalSkillProvider, SkillPlatform } from "../../src/skills/platform.js";
import { HookEngine } from "../../src/core/hook-engine.js";
import { cleanupContext, makeContext } from "../helpers.js";
import { makeWorkspace } from "../helpers.js";

test("enabled plugin contributions activate hooks, MCP servers and executable scripts", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "demo", "1.0.0");
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(root, "registry.json"), JSON.stringify({ demo: { id: "demo", enabled: true, activeVersion: "1.0.0", versions: ["1.0.0"] } }));
  await fs.writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ id: "demo", version: "1.0.0", hooks: ["hooks.json"], mcpServers: ["mcp.json"], tools: ["tools.json"] }));
  await fs.writeFile(path.join(pluginRoot, "hooks.json"), JSON.stringify({ id: "start", event: "SessionStart", command: "node", args: ["-e", ""] }));
  await fs.writeFile(path.join(pluginRoot, "mcp.json"), JSON.stringify({ docs: { transport: "stdio", command: "node", args: ["server.js"], cwd: "." } }));
  await fs.writeFile(path.join(pluginRoot, "tools.json"), JSON.stringify({ name: "hello", description: "say hello", script: "tool.js", readOnly: true }));
  await fs.writeFile(path.join(pluginRoot, "tool.js"), "console.log('hello')");
  const manager = new PluginLifecycleManager(root);
  const contributions = await manager.contributions();
  assert.equal(contributions.length, 1);
  assert.equal(contributions[0].hooks[0].id, "demo@1.0.0:start");
  assert.equal(contributions[0].mcpServers["demo.docs"].command, "node");
  assert.equal(contributions[0].scripts[0].scriptPath, await fs.realpath(path.join(pluginRoot, "tool.js")));
});

test("plugin activation swaps tool generation and disable removes runtime contributions", async (t) => {
  const workspace = await makeWorkspace(); const installRoot = path.join(workspace, "plugins");
  const ctx = await makeContext(workspace); t.after(() => cleanupContext(ctx));
  const pluginRoot = path.join(installRoot, "demo", "1.0.0"); await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(installRoot, "registry.json"), JSON.stringify({ demo: { id: "demo", enabled: true, activeVersion: "1.0.0", versions: ["1.0.0"] } }));
  await fs.writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ id: "demo", version: "1.0.0", tools: ["tools.json"] }));
  await fs.writeFile(path.join(pluginRoot, "tools.json"), JSON.stringify({ name: "hello", description: "say hello", script: "tool.js", readOnly: true }));
  await fs.writeFile(path.join(pluginRoot, "tool.js"), "console.log('hello')");
  const lifecycle = new PluginLifecycleManager(installRoot); const local = new LocalSkillProvider("local", workspace, { userRoots: [] });
  ctx.skillPlatform = new SkillPlatform([local]); ctx.hooks = new HookEngine([]);
  const activation = new PluginActivationManager(lifecycle, [local], [], []);
  const active = await activation.refresh(ctx); assert.ok(active.generation > 0); assert.ok(ctx.registry.get("skill.plugin.demo.hello"));
  await lifecycle.disable("demo"); await activation.refresh(ctx); assert.equal(ctx.registry.get("skill.plugin.demo.hello"), undefined);
  await activation.close(); await ctx.skillPlatform.close();
});

test("failed plugin activation preserves the previous live generation", async (t) => {
  const workspace = await makeWorkspace(); const installRoot = path.join(workspace, "plugins");
  const ctx = await makeContext(workspace); t.after(() => cleanupContext(ctx));
  const goodRoot = path.join(installRoot, "good", "1.0.0"); const badRoot = path.join(installRoot, "bad", "1.0.0");
  await fs.mkdir(goodRoot, { recursive: true }); await fs.mkdir(badRoot, { recursive: true });
  await fs.writeFile(path.join(installRoot, "registry.json"), JSON.stringify({
    good: { id: "good", enabled: true, activeVersion: "1.0.0", versions: ["1.0.0"] },
    bad: { id: "bad", enabled: false, activeVersion: "1.0.0", versions: ["1.0.0"] },
  }));
  await fs.writeFile(path.join(goodRoot, "plugin.json"), JSON.stringify({ id: "good", version: "1.0.0", tools: ["tools.json"] }));
  await fs.writeFile(path.join(goodRoot, "tools.json"), JSON.stringify({ name: "stable", description: "stable tool", script: "tool.js", readOnly: true }));
  await fs.writeFile(path.join(goodRoot, "tool.js"), "console.log('stable')");
  await fs.writeFile(path.join(badRoot, "plugin.json"), JSON.stringify({ id: "bad", version: "1.0.0", mcpServers: ["mcp.json"] }));
  await fs.writeFile(path.join(badRoot, "mcp.json"), JSON.stringify({ broken: { transport: "stdio", command: process.execPath, args: [path.join(badRoot, "missing-server.mjs")], timeoutMs: 500 } }));
  const lifecycle = new PluginLifecycleManager(installRoot); const local = new LocalSkillProvider("local", workspace, { userRoots: [] });
  ctx.skillPlatform = new SkillPlatform([local]); ctx.hooks = new HookEngine([]);
  const activation = new PluginActivationManager(lifecycle, [local], [], []);
  const first = await activation.refresh(ctx); const generation = first.generation;
  assert.ok(ctx.registry.get("skill.plugin.good.stable"));
  await lifecycle.enable("bad");
  await assert.rejects(() => activation.refresh(ctx));
  assert.equal(activation.status().generation, generation);
  assert.ok(ctx.registry.get("skill.plugin.good.stable"));
  await activation.close(); await ctx.skillPlatform.close();
});

test("plugin lifecycle checkpoint restores registry and removed files", async (t) => {
  const installRoot = await makeWorkspace(); t.after(() => fs.rm(installRoot, { recursive: true, force: true }));
  const root = path.join(installRoot, "demo", "1.0.0"); await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({ id: "demo", version: "1.0.0" }));
  await fs.writeFile(path.join(installRoot, "registry.json"), JSON.stringify({ demo: { id: "demo", enabled: true, activeVersion: "1.0.0", versions: ["1.0.0"] } }));
  const lifecycle = new PluginLifecycleManager(installRoot); const checkpoint = await lifecycle.checkpoint();
  await lifecycle.uninstall("demo"); assert.equal(lifecycle.list().length, 0);
  await lifecycle.restore(checkpoint);
  assert.equal(lifecycle.list()[0].activeVersion, "1.0.0");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8")).id, "demo");
});
