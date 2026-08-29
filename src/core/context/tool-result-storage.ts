import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;
export const DEFAULT_PREVIEW_SIZE_CHARS = 2_000;

export interface StoredToolResult {
  filePath: string;
  output: string;
  persisted: boolean;
}

export class ToolResultStorage {
  constructor(
    private sessionDir: string,
    private maxChars = DEFAULT_MAX_RESULT_SIZE_CHARS,
    private previewChars = DEFAULT_PREVIEW_SIZE_CHARS,
  ) {}

  async persistIfLarge(toolName: string, callId: string, output: string): Promise<string> {
    if (output.length <= this.maxChars) return output;

    const safeCallId = callId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = path.join(this.sessionDir, "tool-results", `${safeCallId}.txt`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, output, "utf8");

    const preview = output.slice(0, this.previewChars);
    return [
      "<persisted-output>",
      `Tool ${toolName} output is ${output.length} characters. Full output saved to: ${filePath}`,
      `Preview (first ${this.previewChars} characters):`,
      preview,
      "</persisted-output>",
    ].join("\n");
  }
}
