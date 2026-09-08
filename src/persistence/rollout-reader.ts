import fs from "node:fs/promises";
import { parseTranscriptEnvelope, type TranscriptEnvelope } from "./rollout-schema.js";

export interface RolloutReadResult {
  records: TranscriptEnvelope[];
  repairedPartialTail: boolean;
}

export async function readRollout(filePath: string, options: { repairPartialTail?: boolean } = {}): Promise<RolloutReadResult> {
  const content = await fs.readFile(filePath);
  let complete = content;
  let repairedPartialTail = false;
  if (content.length > 0 && content[content.length - 1] !== 0x0a) {
    const lastNewline = content.lastIndexOf(0x0a);
    complete = lastNewline < 0 ? Buffer.alloc(0) : content.subarray(0, lastNewline + 1);
    repairedPartialTail = true;
    if (options.repairPartialTail !== false) await fs.truncate(filePath, complete.length);
  }

  const text = complete.toString("utf8");
  const lines = text.split("\n");
  const records: TranscriptEnvelope[] = [];
  let previousOrdinal = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Transcript 第 ${index + 1} 行不是有效 JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const record = parseTranscriptEnvelope(parsed, index + 1);
    if (record.ordinal <= previousOrdinal) {
      throw new Error(`Transcript 第 ${index + 1} 行 ordinal ${record.ordinal} 未严格递增`);
    }
    previousOrdinal = record.ordinal;
    records.push(record);
  }
  return { records, repairedPartialTail };
}
