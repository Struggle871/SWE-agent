import path from "node:path";
import { createSessionId, createWindowId, type SessionId } from "../protocol/ids.js";
import { readRollout } from "./rollout-reader.js";
import { RolloutWriter } from "./rollout-writer.js";
import type { SessionMetaPayload, TranscriptEnvelope } from "./rollout-schema.js";
import { reconstructSession, type ReconstructedSession } from "./reconstruction.js";
import { SessionIndex } from "./session-index.js";

export class TranscriptStore {
  readonly index: SessionIndex;

  constructor(readonly rootDir: string) {
    this.index = new SessionIndex(rootDir);
  }

  transcriptPath(sessionId: SessionId): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("sessionId 不能用于文件路径");
    return path.join(this.rootDir, "transcripts", `${sessionId}.jsonl`);
  }

  createWriter(sessionId: SessionId, nextOrdinal = 0): RolloutWriter {
    const transcriptPath = this.transcriptPath(sessionId);
    return new RolloutWriter(transcriptPath, sessionId, nextOrdinal, (record) => this.index.update(record, transcriptPath).catch(() => undefined));
  }

  async resume(sessionId: SessionId): Promise<{ state: ReconstructedSession; writer: RolloutWriter; repairedPartialTail: boolean }> {
    const transcriptPath = this.transcriptPath(sessionId);
    const { records, repairedPartialTail } = await readRollout(transcriptPath);
    const state = reconstructSession(records);
    return { state, writer: this.createWriter(sessionId, state.lastOrdinal + 1), repairedPartialTail };
  }

  async fork(
    parentSessionId: SessionId,
    options: { atOrdinal?: number; reason?: string; newSessionId?: SessionId } = {},
  ): Promise<{ state: ReconstructedSession; writer: RolloutWriter }> {
    const parent = await readRollout(this.transcriptPath(parentSessionId), { repairPartialTail: false });
    if (parent.records.length === 0) throw new Error(`父 session ${parentSessionId} 没有 transcript`);
    const lastOrdinal = parent.records.at(-1)?.ordinal ?? -1;
    const atOrdinal = options.atOrdinal ?? lastOrdinal;
    if (!Number.isInteger(atOrdinal) || atOrdinal < 0 || atOrdinal > lastOrdinal) throw new Error(`fork ordinal 超出范围: ${atOrdinal}`);
    const sessionId = options.newSessionId ?? createSessionId();
    const parentMeta = parent.records[0].payload as SessionMetaPayload;
    const writer = this.createWriter(sessionId);
    await writer.append("session_meta", {
      cwd: parentMeta.cwd,
      model: parentMeta.model,
      initialWindowId: createWindowId(),
      parentSessionId,
      forkedAtOrdinal: atOrdinal,
    });
    for (const record of parent.records) {
      if (record.ordinal > atOrdinal || record.kind === "session_meta") continue;
      await writer.append(record.kind, record.payload, {
        turnId: record.turnId,
        stepId: record.stepId,
        timestamp: record.timestamp,
        inheritedFrom: { sessionId: parentSessionId, ordinal: record.ordinal },
      });
    }
    await writer.append("fork_created", { parentSessionId, forkedAtOrdinal: atOrdinal, reason: options.reason });
    await writer.flush();
    const { records } = await readRollout(this.transcriptPath(sessionId), { repairPartialTail: false });
    return { state: reconstructSession(records), writer };
  }
}
