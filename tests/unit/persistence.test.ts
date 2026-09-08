import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createSessionId, createTurnId, createWindowId } from "../../src/protocol/ids.js";
import { readRollout } from "../../src/persistence/rollout-reader.js";
import { RolloutWriter } from "../../src/persistence/rollout-writer.js";
import { reconstructSession } from "../../src/persistence/reconstruction.js";
import { SessionIndex } from "../../src/persistence/session-index.js";
import { TranscriptStore } from "../../src/persistence/transcript-store.js";
import { makeWorkspace } from "../helpers.js";

test("reader repairs an unterminated tail but rejects a malformed complete line", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = createSessionId();
  const file = path.join(root, `${sessionId}.jsonl`);
  const writer = new RolloutWriter(file, sessionId);
  await writer.append("session_meta", { cwd: root, model: "test" });
  await writer.shutdown();

  await fs.appendFile(file, "{\"schemaVersion\":1", "utf8");
  const repaired = await readRollout(file);
  assert.equal(repaired.repairedPartialTail, true);
  assert.equal(repaired.records.length, 1);
  assert.equal((await fs.readFile(file, "utf8")).endsWith("\n"), true);

  await fs.appendFile(file, "{bad json}\n", "utf8");
  await assert.rejects(readRollout(file), /不是有效 JSON/);
});

test("reader rejects duplicate or decreasing ordinals", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = createSessionId();
  const file = path.join(root, "duplicate.jsonl");
  const base = { schemaVersion: 1, timestamp: Date.now(), sessionId };
  await fs.writeFile(file, [
    JSON.stringify({ ...base, ordinal: 0, kind: "session_meta", payload: { cwd: root, model: "test" } }),
    JSON.stringify({ ...base, ordinal: 0, kind: "message", payload: { message: { role: "user", content: "x" } } }),
    "",
  ].join("\n"), "utf8");
  await assert.rejects(readRollout(file), /未严格递增/);
});

test("reconstruction classifies incomplete side effects as unknown outcomes", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TranscriptStore(root);
  const sessionId = createSessionId();
  const turnId = createTurnId();
  const writer = store.createWriter(sessionId);
  await writer.append("session_meta", { cwd: root, model: "test" });
  await writer.append("turn_started", { userRequest: "write" }, { turnId });
  await writer.append("tool_call", { callId: "call-1", name: "write_file", input: { path: "x" }, sideEffecting: true }, { turnId });
  await writer.shutdown();

  const state = reconstructSession((await readRollout(store.transcriptPath(sessionId))).records);
  assert.deepEqual(state.incompleteTurnIds, [turnId]);
  assert.deepEqual(state.unknownOutcomes.map((outcome) => outcome.callId), ["call-1"]);
  assert.equal(state.unknownOutcomes[0].sideEffecting, true);
});

test("session index can be deleted and rebuilt from JSONL", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new TranscriptStore(root);
  const sessionId = createSessionId();
  const writer = store.createWriter(sessionId);
  await writer.append("session_meta", { cwd: root, model: "test" });
  await writer.append("message", { message: { role: "user", content: "hello" } });
  await writer.shutdown();
  await fs.rm(store.index.indexPath, { force: true });

  const entries = await new SessionIndex(root).list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, sessionId);
  assert.equal(entries[0].lastOrdinal, 1);
});

test("reader rejects malformed checkpoint metadata and reconstruction rejects a broken window chain", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionId = createSessionId();
  const malformed = path.join(root, "malformed.jsonl");
  const base = { schemaVersion: 2, timestamp: Date.now(), sessionId };
  await fs.writeFile(malformed, [
    JSON.stringify({ ...base, ordinal: 0, kind: "session_meta", payload: { cwd: root, model: "test" } }),
    JSON.stringify({
      ...base, ordinal: 1, kind: "compact_checkpoint", payload: {
        compactionId: "compact", status: "completed",
        replacementHistory: [{ id: "item", message: { role: "user", content: "x" } }],
        window: { windowNumber: 1, firstWindowId: "first", previousWindowId: "first", windowId: "next" },
        sourceThroughOrdinal: 0,
      },
    }),
    "",
  ].join("\n"), "utf8");
  await assert.rejects(readRollout(malformed), /context item envelope/);

  const initialWindowId = createWindowId();
  const firstWindowId = createWindowId();
  const secondWindowId = createWindowId();
  const store = new TranscriptStore(path.join(root, "chain"));
  const writer = store.createWriter(sessionId);
  await writer.append("session_meta", { cwd: root, model: "test", initialWindowId });
  await writer.append("compact_checkpoint", checkpointPayload(initialWindowId, initialWindowId, firstWindowId, 1) as never);
  await writer.append("compact_checkpoint", checkpointPayload(initialWindowId, createWindowId(), secondWindowId, 2) as never);
  await writer.shutdown();
  const records = (await readRollout(store.transcriptPath(sessionId))).records;
  assert.throws(() => reconstructSession(records), /window lineage 损坏/);
});

function checkpointPayload(firstWindowId: string, previousWindowId: string, windowId: string, windowNumber: number) {
  return {
    compactionId: `compact-${windowNumber}`,
    trigger: "manual",
    reason: "user_requested",
    phase: "standalone_turn",
    implementation: "new_context_window",
    status: "completed",
    replacementHistory: [],
    window: { windowNumber, firstWindowId, previousWindowId, windowId },
    tokenUsage: { activeBefore: 1, activeAfter: 0, estimateBefore: 1, estimateAfter: 0 },
    sourceThroughOrdinal: 0,
    sourceTurnIds: [],
  };
}
