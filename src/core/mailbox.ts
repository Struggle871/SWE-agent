import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface MailboxMessage { id: string; from: string; to: string; body: string; timestamp: number; delivered: boolean }

/** Append-only mailbox; each write is durable before the caller receives success. */
export class MailboxStore {
  constructor(private readonly filePath: string) {}

  async send(from: string, to: string, body: string): Promise<MailboxMessage> {
    const message: MailboxMessage = { id: randomUUID(), from, to, body, timestamp: Date.now(), delivered: true };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(message)}\n`, "utf8");
    return message;
  }

  async list(recipient?: string): Promise<MailboxMessage[]> {
    try {
      const lines = (await fs.readFile(this.filePath, "utf8")).split(/\r?\n/).filter(Boolean);
      return lines.map((line) => JSON.parse(line) as MailboxMessage).filter((message) => !recipient || message.to === recipient);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
