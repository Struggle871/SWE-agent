import assert from "node:assert/strict";
import test from "node:test";
import { Executor } from "../../src/core/executor.js";
import { ToolRouter } from "../../src/core/tool-router.js";
import { StreamingToolExecutor } from "../../src/core/streaming-executor.js";
import { UnavailableSandboxProvider } from "../../src/security/sandbox.js";
import { ToolConfigurationError, ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/types.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";

test("registry rejects duplicate names and exposes specs separately from runtime", () => {
  const tool: Tool = { name: "one", description: "one", parameters: { type: "object", properties: {} }, async execute() { return { toolName: "one", output: "ok" }; } };
  const registry = new ToolRegistry();
  registry.register(tool);
  assert.equal(registry.getRuntime("one")?.execute !== undefined, true);
  assert.equal("execute" in (registry.getSpec("one") ?? {}), false);
  assert.throws(() => registry.register(tool), ToolConfigurationError);
});

test("router reports schema field paths and does not invoke runtime", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  let calls = 0;
  const tool: Tool = { name: "typed", description: "typed", parameters: { type: "object", properties: { count: { type: "number" } }, required: ["count"] }, async execute() { calls += 1; return { toolName: "typed", output: "ran" }; } };
  ctx.registry.register(tool);
  const result = await new Executor().execute({ type: "tool_call", toolName: "typed", toolInput: { count: "bad" } }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.output, /\$\.count/);
  assert.equal(calls, 0);
});

test("router refuses command execution when sandbox capability is unavailable", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  ctx.sandboxProvider = new UnavailableSandboxProvider();
  t.after(() => cleanupContext(ctx));
  const result = await new ToolRouter().route({ type: "tool_call", toolName: "run_command", toolInput: { command: process.platform === "win32" ? "echo ok" : "echo ok" } }, ctx, { callId: "sandbox-test", signal: new AbortController().signal });
  assert.equal(result.isError, true);
  assert.match(result.output, /sandbox|沙箱/);
  assert.ok(ctx.auditTrail.list().some((record) => record.error?.includes("sandbox capability missing") || record.error?.includes("沙箱缺少")));
});

test("read tools share the gate while writes wait and results stay ordered", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  let active = 0;
  let maxActiveReads = 0;
  const events: string[] = [];
  const makeRead = (name: string, delay: number): Tool => ({
    name, description: name, isReadOnly: true, parameters: { type: "object", properties: {} },
    async execute() { active += 1; maxActiveReads = Math.max(maxActiveReads, active); await new Promise((resolve) => setTimeout(resolve, delay)); active -= 1; events.push(name); return { toolName: name, output: name }; },
  });
  const write: Tool = { name: "gate_write", description: "write", parameters: { type: "object", properties: {} }, async execute() { assert.equal(active, 0); events.push("write"); return { toolName: "gate_write", output: "write" }; } };
  ctx.registry.register(makeRead("gate_read_a", 20));
  ctx.registry.register(makeRead("gate_read_b", 5));
  ctx.registry.register(write);
  const queue = new StreamingToolExecutor(ctx);
  queue.addTool({ type: "tool_call", toolName: "gate_read_a", toolInput: {} });
  queue.addTool({ type: "tool_call", toolName: "gate_read_b", toolInput: {} });
  queue.addTool({ type: "tool_call", toolName: "gate_write", toolInput: {} });
  const results = await queue.collect();
  assert.equal(maxActiveReads, 2);
  assert.deepEqual(results.map((result) => result.toolName), ["gate_read_a", "gate_read_b", "gate_write"]);
  assert.equal(events.at(-1), "write");
});
