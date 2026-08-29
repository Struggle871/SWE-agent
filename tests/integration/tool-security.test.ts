import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Executor } from "../../src/core/executor.js";
import { StaticApprovalBroker } from "../../src/security/approval-broker.js";
import { AuditTrail } from "../../src/security/audit.js";
import type { Tool } from "../../src/tools/types.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";

test("read tools auto-allow and write tools expose a diff preview", async (t) => {
  const root = await makeWorkspace();
  const broker = new StaticApprovalBroker(true);
  const ctx = await makeContext(root, broker);
  t.after(() => cleanupContext(ctx));
  const file = path.join(root, "sample.txt");
  await fs.writeFile(file, "old\n", "utf8");
  const executor = new Executor();
  const previews: string[] = [];

  const read = await executor.execute({ type: "tool_call", toolName: "read_file", toolInput: { path: "sample.txt" } }, ctx, {
    onEvent: (event) => { if (event.type === "tool_preview") previews.push(event.preview.risk); },
  });
  assert.equal(read.isError, undefined);
  assert.equal(broker.requests.length, 0);

  const write = await executor.execute({ type: "tool_call", toolName: "write_file", toolInput: { path: "sample.txt", content: "new\n" } }, ctx, {
    onEvent: (event) => { if (event.type === "tool_preview") previews.push(event.preview.diff ?? ""); },
  });
  assert.equal(write.isError, undefined);
  assert.equal(broker.requests.length, 1);
  assert.match(previews.join("\n"), /-old/);
  assert.match(previews.join("\n"), /\+new/);
  assert.equal(await fs.readFile(file, "utf8"), "new\n");
});

test("denied approvals never invoke the runtime", async (t) => {
  const root = await makeWorkspace();
  const ctx = await makeContext(root, new StaticApprovalBroker(false));
  t.after(() => cleanupContext(ctx));
  let calls = 0;
  const tool: Tool = {
    name: "dangerous_custom", description: "custom side effect", parameters: { type: "object", properties: {} },
    async execute() { calls += 1; return { toolName: "dangerous_custom", output: "ran" }; },
  };
  ctx.registry.register(tool);
  const result = await new Executor().execute({ type: "tool_call", toolName: tool.name, toolInput: {} }, ctx);
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});

test("command analyzer ask cannot be downgraded by the read permission policy", async (t) => {
  const root = await makeWorkspace();
  const broker = new StaticApprovalBroker(false);
  const ctx = await makeContext(root, broker);
  t.after(() => cleanupContext(ctx));
  let shellCalls = 0;
  const originalRun = ctx.shell.run.bind(ctx.shell);
  ctx.shell.run = async (...args) => {
    shellCalls += 1;
    return originalRun(...args);
  };

  const command = process.platform === "win32" ? "type missing.txt > copied.txt" : "cat missing.txt > copied.txt";
  const result = await new Executor().execute({
    type: "tool_call", toolName: "run_command", toolInput: { command },
  }, ctx);

  assert.equal(result.isError, true);
  assert.equal(broker.requests.length, 1);
  assert.equal(shellCalls, 0);
});

test("direct traversal and search traversal are rejected", async (t) => {
  const root = await makeWorkspace();
  const ctx = await makeContext(root);
  t.after(() => cleanupContext(ctx));
  const executor = new Executor();
  for (const toolName of ["read_file", "search_files", "search_content"]) {
    const input = toolName === "read_file" ? { path: "../outside.txt" } : { path: "..", pattern: "*" };
    const result = await executor.execute({ type: "tool_call", toolName, toolInput: input }, ctx);
    assert.equal(result.isError, true, toolName);
  }
});

test("search rejects a start directory linked outside the workspace", async (t) => {
  const root = await makeWorkspace();
  const outside = await makeWorkspace();
  const ctx = await makeContext(root);
  t.after(async () => { await cleanupContext(ctx); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  try {
    await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`当前环境不能创建目录链接: ${String(error)}`);
    return;
  }
  const result = await new Executor().execute({
    type: "tool_call", toolName: "search_files", toolInput: { path: "linked", pattern: "*" },
  }, ctx);
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.output, /secret\.txt/);
});

test("bypass-immune paths are denied even when broker allows", async (t) => {
  const root = await makeWorkspace();
  const broker = new StaticApprovalBroker(true);
  const ctx = await makeContext(root, broker);
  t.after(() => cleanupContext(ctx));
  const result = await new Executor().execute({
    type: "tool_call", toolName: "write_file", toolInput: { path: ".git/config", content: "unsafe" },
  }, ctx);
  assert.equal(result.isError, true);
  assert.equal(broker.requests.length, 0);
});

test("approval is invalidated when the file changes while waiting", async (t) => {
  const root = await makeWorkspace();
  const file = path.join(root, "race.txt");
  await fs.writeFile(file, "v1", "utf8");
  const broker = new StaticApprovalBroker(async () => {
    await fs.writeFile(file, "external", "utf8");
    return true;
  });
  const ctx = await makeContext(root, broker);
  t.after(() => cleanupContext(ctx));
  const executor = new Executor();
  await executor.execute({ type: "tool_call", toolName: "read_file", toolInput: { path: "race.txt" } }, ctx);
  const result = await executor.execute({
    type: "tool_call", toolName: "write_file", toolInput: { path: "race.txt", content: "agent" },
  }, ctx);
  assert.equal(result.isError, true);
  assert.equal(await fs.readFile(file, "utf8"), "external");
});

test("audit records redact secrets", async () => {
  const audit = new AuditTrail();
  const secret = "sk-super-secret-value";
  await audit.record({
    timestamp: Date.now(), callId: "1", toolName: "custom", phase: "preflight",
    input: { apiKey: secret, command: `echo Bearer ${secret}`, content: `source-${secret}` },
  });
  const serialized = JSON.stringify(audit.list());
  assert.doesNotMatch(serialized, /super-secret-value/);
  assert.match(serialized, /REDACTED/);
  assert.match(serialized, /OMITTED/);
});
