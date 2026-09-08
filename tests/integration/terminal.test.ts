import assert from "node:assert/strict";
import test from "node:test";
import { Executor } from "../../src/core/executor.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";

test("shell cwd escapes are denied before execution", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const result = await new Executor().execute({ type: "tool_call", toolName: "run_command", toolInput: { command: "cd .." } }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.output, /拒绝|越出/);
});

test("shell timeout returns an explicit error and the session can execute again", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const executor = new Executor();
  const slow = process.platform === "win32" ? "ping -n 3 127.0.0.1 >nul" : "sleep 2";
  const timedOut = await executor.execute({ type: "tool_call", toolName: "run_command", toolInput: { command: slow, timeoutMs: 25 } }, ctx);
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.output, /超时/);
  const next = await executor.execute({ type: "tool_call", toolName: "run_command", toolInput: { command: process.platform === "win32" ? "echo ok" : "echo ok" } }, ctx);
  assert.equal(next.isError, false);
  assert.match(next.output, /ok/);
});

test("command execution audit records the selected sandbox guarantees", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const result = await new Executor().execute({ type: "tool_call", toolName: "run_command", toolInput: { command: "echo audited" } }, ctx);
  assert.equal(result.isError, false);
  const execution = ctx.auditTrail.list().find((record) => record.phase === "execution" && record.toolName === "run_command" && record.success === true);
  assert.equal(execution?.sandbox?.provider, process.platform);
  assert.equal(execution?.sandbox?.actualEnforcement, "best_effort");
  assert.equal(execution?.sandbox?.requestedNetwork, "deny");
});
