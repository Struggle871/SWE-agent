import fs from "node:fs/promises";
import path from "node:path";
import type { SessionId, StepId, TurnId } from "../protocol/ids.js";
import { envelope } from "../core/context/compaction-history.js";
import type { MessagePayload } from "./rollout-schema.js";
import {
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptEnvelope,
  type TranscriptKind,
  type TranscriptPayload,
} from "./rollout-schema.js";

export interface AppendContext {
  turnId?: TurnId;
  stepId?: StepId;
  timestamp?: number;
  inheritedFrom?: { sessionId: SessionId; ordinal: number };
  durable?: boolean;
}

const activeFiles = new Set<string>();

/** One ordered append queue for one live session transcript. */
export class RolloutWriter {
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private nextOrdinal: number;
  private initialized = false;

  constructor(
    readonly filePath: string,
    readonly sessionId: SessionId,
    nextOrdinal = 0,
    private readonly onAppend?: (record: TranscriptEnvelope) => Promise<void>,
  ) {
    const key = path.resolve(filePath).toLowerCase();
    if (activeFiles.has(key)) throw new Error(`Session ${sessionId} 已有 active transcript writer`);
    activeFiles.add(key);
    this.nextOrdinal = nextOrdinal;
  }

  append(kind: TranscriptKind, payload: TranscriptPayload, context: AppendContext = {}): Promise<TranscriptEnvelope> {
    if (this.closed) return Promise.reject(new Error(`Session ${this.sessionId} transcript writer 已关闭`));
    const normalizedPayload = kind === "message" ? canonicalMessagePayload(payload as MessagePayload, context) : payload;
    const record: TranscriptEnvelope = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      ordinal: this.nextOrdinal++,
      timestamp: context.timestamp ?? Date.now(),
      sessionId: this.sessionId,
      kind,
      payload: normalizedPayload,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...(context.stepId ? { stepId: context.stepId } : {}),
      ...(context.inheritedFrom ? { inheritedFrom: context.inheritedFrom } : {}),
    };
    const operation = this.chain.then(async () => {
      if (!this.initialized) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        this.initialized = true;
      }
      await appendWithRetry(this.filePath, `${JSON.stringify(record)}\n`, context.durable === true);
      await this.onAppend?.(record);
      return record;
    });
    this.chain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.flush();
    } finally {
      activeFiles.delete(path.resolve(this.filePath).toLowerCase());
    }
  }
}

function canonicalMessagePayload(payload: MessagePayload, context: AppendContext): MessagePayload {
  if (payload.item) return { item: structuredClone(payload.item) };
  const message = payload.message;
  if (!message) throw new Error("message transcript payload 缺少 item/message");
  return { item: envelope(message, {
    kind: payload.contextItem?.metadata.kind ?? "conversation",
    ...(context.turnId ? { turnId: context.turnId } : {}),
    ...(context.stepId ? { stepId: context.stepId } : {}),
  }) };
}

async function appendWithRetry(filePath: string, text: string, durable: boolean): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (durable) {
        const handle = await fs.open(filePath, "a");
        try {
          await handle.writeFile(text, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        await fs.appendFile(filePath, text, "utf8");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw lastError;
}
