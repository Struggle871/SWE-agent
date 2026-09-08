import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../../src/core/agent-session.js";
import { readRollout } from "../../src/persistence/rollout-reader.js";
import { cleanupContext, makeContext, makeWorkspace } from "../helpers.js";

test("multiple runs persist one canonical transcript and resume it", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const transcriptRoot = path.join(ctx.workspaceRoot, "state");
  const session = new AgentSession(ctx, undefined, { transcriptRoot });
  const first = await session.run("first request");
  const second = await session.run("second request");
  const sessionId = session.sessionId;
  const transcriptPath = session.transcriptPath;
  await session.close();

  assert.equal(first.sessionId, second.sessionId);
  const beforeResume = await readRollout(transcriptPath);
  assert.equal(beforeResume.records.filter((record) => record.kind === "session_meta").length, 1);
  assert.equal(beforeResume.records.filter((record) => record.kind === "turn_started").length, 2);
  assert.equal(beforeResume.records.some((record) => String(record.kind) === "model_event"), false);

  const resumed = await AgentSession.resume(ctx, sessionId, undefined, { transcriptRoot });
  const result = await resumed.run("resumed request");
  assert.equal(result.sessionId, sessionId);
  assert.deepEqual(result.history.filter((message) => message.role === "user").map((message) => message.content), [
    "first request", "second request", "resumed request",
  ]);
  await resumed.close();
});

test("copied fork preserves lineage and never mutates the parent transcript", async (t) => {
  const ctx = await makeContext(await makeWorkspace());
  t.after(() => cleanupContext(ctx));
  const transcriptRoot = path.join(ctx.workspaceRoot, "state");
  const parent = new AgentSession(ctx, undefined, { transcriptRoot });
  await parent.run("parent request");
  const parentId = parent.sessionId;
  const parentPath = parent.transcriptPath;
  await parent.close();
  const parentBefore = await fs.readFile(parentPath, "utf8");
  const parentRecords = (await readRollout(parentPath)).records;
  const boundary = parentRecords.at(-1)?.ordinal ?? 0;

  const fork = await AgentSession.fork(ctx, parentId, { atOrdinal: boundary, reason: "test" }, undefined, { transcriptRoot });
  assert.notEqual(fork.sessionId, parentId);
  assert.equal(fork.recovery?.meta.parentSessionId, parentId);
  assert.equal(fork.recovery?.meta.forkedAtOrdinal, boundary);
  assert.ok(fork.recovery?.history.some((message) => message.role === "user" && message.content === "parent request"));
  await fork.run("child request");
  await fork.close();

  assert.equal(await fs.readFile(parentPath, "utf8"), parentBefore);
  const childRecords = (await readRollout(fork.transcriptPath)).records;
  assert.ok(childRecords.some((record) => record.kind === "fork_created"));
  assert.ok(childRecords.some((record) => record.inheritedFrom?.sessionId === parentId));
});
