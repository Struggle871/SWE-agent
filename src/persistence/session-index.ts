import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionId } from "../protocol/ids.js";
import { readRollout } from "./rollout-reader.js";
import type { SessionMetaPayload, TranscriptEnvelope } from "./rollout-schema.js";

export interface SessionIndexEntry {
  sessionId: SessionId;
  transcriptPath: string;
  cwd: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  lastOrdinal: number;
  parentSessionId?: SessionId;
  forkedAtOrdinal?: number;
}

interface IndexFile { version: 1; sessions: SessionIndexEntry[] }

export class SessionIndex {
  readonly indexPath: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string) {
    this.indexPath = path.join(rootDir, "index.json");
  }

  update(record: TranscriptEnvelope, transcriptPath: string): Promise<void> {
    const operation = this.chain.then(async () => {
      const index = await this.readOrEmpty();
      let entry = index.sessions.find((candidate) => candidate.sessionId === record.sessionId);
      if (!entry) {
        if (record.kind !== "session_meta") return;
        const meta = record.payload as SessionMetaPayload;
        entry = {
          sessionId: record.sessionId,
          transcriptPath,
          cwd: meta.cwd,
          model: meta.model,
          createdAt: record.timestamp,
          updatedAt: record.timestamp,
          lastOrdinal: record.ordinal,
          parentSessionId: meta.parentSessionId,
          forkedAtOrdinal: meta.forkedAtOrdinal,
        };
        index.sessions.push(entry);
      } else {
        entry.updatedAt = record.timestamp;
        entry.lastOrdinal = record.ordinal;
      }
      await this.write(index);
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  async list(): Promise<SessionIndexEntry[]> {
    await this.chain;
    try {
      return (await this.read()).sessions;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return (await this.rebuild()).sessions;
    }
  }

  async rebuild(): Promise<IndexFile> {
    const transcriptsDir = path.join(this.rootDir, "transcripts");
    await fs.mkdir(transcriptsDir, { recursive: true });
    const sessions: SessionIndexEntry[] = [];
    for (const name of await fs.readdir(transcriptsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const transcriptPath = path.join(transcriptsDir, name);
      const { records } = await readRollout(transcriptPath);
      const first = records[0];
      if (!first || first.kind !== "session_meta") continue;
      const meta = first.payload as SessionMetaPayload;
      const last = records.at(-1) ?? first;
      sessions.push({
        sessionId: first.sessionId,
        transcriptPath,
        cwd: meta.cwd,
        model: meta.model,
        createdAt: first.timestamp,
        updatedAt: last.timestamp,
        lastOrdinal: last.ordinal,
        parentSessionId: meta.parentSessionId,
        forkedAtOrdinal: meta.forkedAtOrdinal,
      });
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    const index: IndexFile = { version: 1, sessions };
    await this.write(index);
    return index;
  }

  private async read(): Promise<IndexFile> {
    const parsed = JSON.parse(await fs.readFile(this.indexPath, "utf8")) as IndexFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error("Session index 格式无效");
    return parsed;
  }

  private async readOrEmpty(): Promise<IndexFile> {
    try { return await this.read(); } catch (error) { if (isNotFound(error)) return { version: 1, sessions: [] }; throw error; }
  }

  private async write(index: IndexFile): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const temporary = path.join(this.rootDir, `.index-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.indexPath);
  }
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
