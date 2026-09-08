import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;
export const DEFAULT_PREVIEW_SIZE_CHARS = 2_000;

export interface StoredToolResult {
  output: string;
  persisted: boolean;
  filePath?: string;
  sha256?: string;
  originalCharacters: number;
}

export class ToolResultStorage {
  constructor(
    private sessionDir: string,
    private maxChars = DEFAULT_MAX_RESULT_SIZE_CHARS,
    private previewChars = DEFAULT_PREVIEW_SIZE_CHARS,
  ) {}

  async persistIfLarge(toolName: string, callId: string, output: string): Promise<string> {
    return (await this.store(toolName, callId, output)).output;
  }

  async store(toolName: string, callId: string, output: string): Promise<StoredToolResult> {
    if (output.length <= this.maxChars) return { output, persisted: false, originalCharacters: output.length };

    const hash = createHash("sha256").update(output).digest("hex");
    const safeCallId = callId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "call";
    const filePath = path.join(this.sessionDir, "tool-results", `${safeCallId}-${hash}.txt`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeOnce(filePath, output);

    const preview = output.slice(0, this.previewChars);
    const bounded = [
      "<persisted-output>",
      `Tool ${toolName} output is ${output.length} characters. Full output saved to: ${filePath}`,
      `SHA-256: ${hash}`,
      `Preview (first ${this.previewChars} characters):`,
      preview,
      "</persisted-output>",
    ].join("\n");
    return { output: bounded, persisted: true, filePath, sha256: hash, originalCharacters: output.length };
  }
}

async function writeOnce(filePath: string, output: string): Promise<void> {
  try {
    const handle = await fs.open(filePath, "wx");
    try {
      await handle.writeFile(output, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    const existing = await fs.readFile(filePath, "utf8");
    if (existing !== output) {
      const collision = path.join(path.dirname(filePath), `${path.basename(filePath, ".txt")}-${randomUUID()}.txt`);
      await fs.writeFile(collision, output, { encoding: "utf8", flag: "wx" });
      throw new Error(`tool result hash collision: ${collision}`);
    }
  }
}
