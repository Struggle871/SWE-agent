import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { TaskGraphStore } from "../../src/core/task-graph.js";
import { asSessionId } from "../../src/protocol/ids.js";
import { makeWorkspace } from "../helpers.js";
import { Executor } from "../../src/core/executor.js";
import { taskCreateTool, taskListTool } from "../../src/tools/task-tools.js";
import { AgentManager } from "../../src/core/agent-manager.js";

test("task graph schedules only ready tasks and survives reload", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "tasks", "graph.json");
  const graph = new TaskGraphStore(file);
  await graph.load();
  const first = graph.create({ description: "first", maxAttempts: 2 });
  const second = graph.create({ description: "second", dependsOn: [first.id] });
  assert.equal(graph.isReady(second), false);
  assert.equal(graph.claimReady(asSessionId("session-a"))?.id, first.id);
  assert.equal(graph.claimReady(asSessionId("session-b")), undefined);
  assert.equal(graph.fail(first.id, "retry").status, "retrying");
  assert.equal(graph.claimReady(asSessionId("session-a"))?.id, first.id);
  graph.complete(first.id, "ok");
  assert.equal(graph.claimReady(asSessionId("session-b"))?.id, second.id);

  const restored = new TaskGraphStore(file);
  await restored.load();
  assert.equal(restored.get(first.id)?.resultSummary, "ok");
  assert.equal(restored.get(second.id)?.ownerSessionId, "session-b");
});

test("task graph rejects cycles and cancellation propagates", async () => {
  const graph = new TaskGraphStore();
  await graph.load();
  const first = graph.create({ description: "first" });
  const second = graph.create({ description: "second", dependsOn: [first.id] });
  assert.throws(() => graph.update(first.id, { dependsOn: [second.id] }), /循环依赖/);
  assert.deepEqual(graph.get(first.id)?.dependsOn, []);
  graph.cancel(first.id, "stop");
  assert.equal(graph.get(second.id)?.status, "cancelled");
});

test("task graph emits one canonical lifecycle event per mutation", async () => {
  const operations: string[] = [];
  const graph = new TaskGraphStore(undefined, (event) => { operations.push(event.operation); });
  await graph.load();
  const task = graph.create({ description: "single event", maxAttempts: 1 });
  graph.claimReady(asSessionId("session-events"));
  graph.complete(task.id, "done");
  assert.deepEqual(operations, ["create", "claim", "complete"]);
});

test("task graph detects a competing process revision without losing committed data", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "graph.json");
  const first = new TaskGraphStore(file);
  const second = new TaskGraphStore(file);
  await Promise.all([first.load(), second.load()]);
  first.create({ description: "winner" });
  assert.throws(() => second.create({ description: "stale writer" }), /revision 冲突/);
  const restored = new TaskGraphStore(file);
  await restored.load();
  assert.deepEqual(restored.list().map((task) => task.description), ["winner"]);
});

test("task graph and child-agent controls are reachable through the ToolRouter", async (t) => {
  const root = await makeWorkspace();
  const ctx = await (await import("../helpers.js")).makeContext(root);
  t.after(() => (async () => { await ctx.agentManager?.close(); await (await import("../helpers.js")).cleanupContext(ctx); })());
  ctx.taskGraph = new TaskGraphStore();
  ctx.agentManager = new AgentManager(ctx, path.join(root, "sessions"));
  ctx.registry.register(taskCreateTool);
  ctx.registry.register(taskListTool);
  const executor = new Executor();
  const created = await executor.execute({ type: "tool_call", toolName: "task_create", toolInput: { description: "public task" } }, ctx);
  assert.equal(created.isError, undefined);
  const listed = await executor.execute({ type: "tool_call", toolName: "task_list", toolInput: {} }, ctx);
  assert.match(listed.output, /public task/);
  assert.ok(ctx.auditTrail.list().some((record) => record.toolName === "task_create" && record.phase === "preflight"));
});
