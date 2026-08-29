import fs from "node:fs/promises";
import path from "node:path";
import type { ApprovalResult } from "./approval-broker.js";
import type { ToolDecision, ToolExecutionPreview } from "../tools/preview.js";

export interface AuditRecord {
  timestamp: number;
  callId: string;
  toolName: string;
  phase: "preflight" | "approval" | "revalidation" | "execution";
  decision?: ToolDecision;
  preview?: ToolExecutionPreview;
  input?: Record<string, unknown>;
  approval?: ApprovalResult;
  success?: boolean;
  error?: string;
  beforeHashes?: Record<string, string | null>;
  afterHashes?: Record<string, string | null>;
}

export class AuditTrail {
  private records: AuditRecord[] = [];

  constructor(private filePath?: string) {}

  async record(record: AuditRecord): Promise<void> {
    const safe = redactSecrets(record) as AuditRecord;
    this.records.push(safe);
    if (!this.filePath) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(safe)}\n`, "utf8");
  }

  list(): readonly AuditRecord[] {
    return this.records;
  }
}

const SECRET_KEY = /(?:api[_-]?key|token|authorization|password|passwd|secret|cookie)/i;
const CONTENT_KEY = /^(?:content|old_string|new_string|diff|body)$/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/-]+/gi;
const ENV_SECRET = /\b([A-Za-z_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)[A-Za-z_]*)\s*=\s*([^\s;&|]+)/gi;

export function redactSecrets(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (CONTENT_KEY.test(key) && typeof value === "string") return `[OMITTED:${value.length} chars]`;
  if (typeof value === "string") {
    return value
      .replace(BEARER, "Bearer [REDACTED]")
      .replace(ENV_SECRET, "$1=[REDACTED]")
      .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSecrets(entryValue, entryKey)]));
  }
  return value;
}
