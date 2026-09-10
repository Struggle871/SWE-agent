import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "../../src/core/agent-session.js";
import { HookEngine } from "../../src/core/hook-engine.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";
import { readRollout } from "../../src/persistence/rollout-reader.js";
import { Executor } from "../../src/core/executor.js";
import type { Tool } from "../../src/tools/types.js";

test("UserPromptSubmit hook can block through the session public path", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  ctx.config.hooks = [{ id: "block-secret", event: "UserPromptSubmit", command: process.execPath, args: ["-e", "console.log(JSON.stringify({blocked:true,reason:'policy'}))"] }];
  const session = new AgentSession(ctx);
  await assert.rejects(() => session.run("do not run"), /policy/);
  await session.flush();
  const rollout = await readRollout(session.transcriptPath);
  assert.equal(rollout.records.some((record) => record.kind === "hook_lifecycle" && (record.payload as { status?: string }).status === "blocked"), true);
  await session.close();
});

test("hook output can add context and matcher limits execution", async () => {
  const ctx = await makeContext(await makeWorkspace());
  try {
    const engine = new HookEngine([{ id: "annotate", event: "PreToolUse", command: process.execPath, args: ["-e", "console.log(JSON.stringify({additionalContext:'reviewed'}))"], matcher: "read_file" }]);
    const applied = await engine.dispatch("PreToolUse", { toolName: "read_file" }, ctx);
    assert.equal(applied.blocked, false);
    assert.equal(applied.additionalContext, "reviewed");
    const skipped = await engine.dispatch("PreToolUse", { toolName: "write_file" }, ctx);
    assert.deepEqual(skipped.hookIds, []);
  } finally { await cleanupContext(ctx); }
});

test("tool hooks rewrite input, return context, and can block the exposed result", async () => {
  const ctx = await makeContext(await makeWorkspace());
  try {
    const tool: Tool = { name: "hook_target", description: "hook target", isReadOnly: true, parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, async execute(input) { return { toolName: "hook_target", output: String(input.value) }; } };
    ctx.registry.register(tool);
    ctx.hooks = new HookEngine([
      { id: "rewrite", event: "PreToolUse", matcher: "hook_target", command: process.execPath, args: ["-e", "console.log(JSON.stringify({rewrittenInput:{value:'rewritten'},additionalContext:'pre-note'}))"] },
      { id: "annotate", event: "PostToolUse", matcher: "hook_target", command: process.execPath, args: ["-e", "console.log(JSON.stringify({additionalContext:'post-note'}))"] },
    ]);
    const result = await new Executor().execute({ type: "tool_call", toolName: "hook_target", toolInput: { value: "original" } }, ctx);
    assert.match(result.output, /^rewritten/);
    assert.match(result.output, /pre-note/);
    assert.match(result.output, /post-note/);
    ctx.hooks = new HookEngine([{ id: "hide", event: "PostToolUse", matcher: "hook_target", command: process.execPath, args: ["-e", "console.log(JSON.stringify({blocked:true,reason:'post policy'}))"] }]);
    const blocked = await new Executor().execute({ type: "tool_call", toolName: "hook_target", toolInput: { value: "value" } }, ctx);
    assert.equal(blocked.isError, true); assert.match(blocked.output, /post policy/);
  } finally { await cleanupContext(ctx); }
});

test("hook timeout and output limit follow configured block policies", async () => {
  const ctx = await makeContext(await makeWorkspace());
  try {
    const timeout = new HookEngine([{ id: "slow", event: "Stop", command: process.execPath, args: ["-e", "setTimeout(()=>{},1000)"], timeoutMs: 20, onTimeout: "block" }]);
    assert.equal((await timeout.dispatch("Stop", {}, ctx)).blocked, true);
    const oversized = new HookEngine([{ id: "large", event: "Stop", command: process.execPath, args: ["-e", "console.log('x'.repeat(100))"], onError: "block" }], { maxOutputBytes: 16 });
    const result = await oversized.dispatch("Stop", {}, ctx);
    assert.equal(result.blocked, true); assert.match(result.reason ?? "", /输出超过/);
  } finally { await cleanupContext(ctx); }
});
