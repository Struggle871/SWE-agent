import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AgentManager } from "../../src/core/agent-manager.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";
import { TaskGraphStore } from "../../src/core/task-graph.js";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/protocol/model-events.js";

test("local child agent owns a separate transcript and durable mailbox", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  const transcriptRoot = path.join(ctx.workspaceRoot, "runtime", "sessions");
  const manager = new AgentManager(ctx, transcriptRoot);
  try {
    const child = await manager.spawn("inspect", "parent-session");
    assert.match(child.id, /^[0-9a-f-]{36}$/);
    assert.ok(child.transcriptPath?.includes(path.join("children", "transcripts")));
    const sent = await manager.send(child.id, "additional context");
    assert.equal(sent.to, child.id);
    assert.equal((await manager.messages(child.id)).length, 1);
    const completed = await manager.wait(child.id, 10_000);
    assert.equal(completed.status, "completed");
    assert.match(completed.result ?? "", /FakeModel/);
    assert.equal((await fs.stat(completed.transcriptPath!)).isFile(), true);
    assert.equal((await fs.readFile(path.join(transcriptRoot, "mailbox.jsonl"), "utf8")).includes("additional context"), true);
  } finally {
    await manager.close();
    await cleanupContext(ctx);
  }
});

test("restart preserves child metadata and marks unknown running work failed", async () => {
  const ctx = await makeContext(await makeWorkspace());
  const transcriptRoot = path.join(ctx.workspaceRoot, "runtime", "sessions");
  await fs.mkdir(transcriptRoot, { recursive: true });
  await fs.writeFile(path.join(transcriptRoot, "agents.json"), JSON.stringify({
    schemaVersion: 1,
    agents: [{ id: "child-before-crash", prompt: "unfinished", status: "running", startedAt: 1 }],
  }), "utf8");
  const manager = new AgentManager(ctx, transcriptRoot);
  try {
    await manager.load();
    const recovered = await manager.wait("child-before-crash", 10);
    assert.equal(recovered.status, "failed");
    assert.match(recovered.error ?? "", /不会自动重放/);
    const persisted = JSON.parse(await fs.readFile(path.join(transcriptRoot, "agents.json"), "utf8")) as { agents: Array<{ status: string }> };
    assert.equal(persisted.agents[0].status, "failed");
  } finally {
    await manager.close();
    await cleanupContext(ctx);
  }
});

test("parent interruption cancels a running child and its bound task", async () => {
  const ctx = await makeContext(await makeWorkspace());
  let started = false;
  const transport: ModelTransport = {
    capabilities: () => ({ nativeToolCalls: true, streamingText: true, usage: false, reasoningDeltas: false }),
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      yield { type: "response_started", requestId: request.requestId };
      started = true;
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("cancelled"));
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
  ctx.model = { chat: async () => "", transport };
  ctx.taskGraph = new TaskGraphStore(); await ctx.taskGraph.load();
  const task = ctx.taskGraph.create({ description: "bound child" });
  const manager = new AgentManager(ctx, path.join(ctx.workspaceRoot, "runtime", "sessions"));
  try {
    const child = await manager.spawn("wait", "parent", { taskId: task.id });
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
    manager.cancelAll("parent interrupted");
    const completed = await manager.wait(child.id, 10_000);
    assert.equal(completed.status, "cancelled");
    assert.equal(ctx.taskGraph.get(task.id)?.status, "cancelled");
  } finally { await manager.close(); await cleanupContext(ctx); }
});

test("child fork modes persist only the selected parent history", async () => {
  const ctx = await makeContext(await makeWorkspace());
  const root = path.join(ctx.workspaceRoot, "runtime", "sessions");
  const parentHistory = [
    { role: "user" as const, content: "OLD_PARENT_TURN" },
    { role: "assistant" as const, content: "old answer" },
    { role: "user" as const, content: "RECENT_PARENT_TURN" },
  ];
  const manager = new AgentManager(ctx, root, undefined, () => parentHistory);
  try {
    const child = await manager.spawn("inspect", "parent", { forkMode: 1 });
    const completed = await manager.wait(child.id, 10_000);
    const transcript = await fs.readFile(completed.transcriptPath!, "utf8");
    assert.equal(transcript.includes("RECENT_PARENT_TURN"), true);
    assert.equal(transcript.includes("OLD_PARENT_TURN"), false);
  } finally { await manager.close(); await cleanupContext(ctx); }
});
