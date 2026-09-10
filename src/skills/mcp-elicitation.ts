import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ElicitationAction = "accept" | "decline" | "cancel";
export interface ElicitationRequest {
  id: string;
  serverId: string;
  mode: "form" | "url";
  message: string;
  requestedSchema?: Record<string, unknown>;
  url?: string;
  elicitationId?: string;
  createdAt: number;
  expiresAt: number;
}
export interface ElicitationResult { action: ElicitationAction; content?: Record<string, string | number | boolean | string[]> }
interface Pending { request: ElicitationRequest; resolve: (result: ElicitationResult) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }

/** Bridges MCP server-initiated elicitation to a UI/App Server without exposing credentials. */
export class McpElicitationBroker {
  private readonly pending = new Map<string, Pending>();
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath?: string, private readonly timeoutMs = 5 * 60_000) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const rows = JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
      if (Array.isArray(rows)) for (const value of rows) {
        if (!value || typeof value !== "object") continue;
        const request = value as ElicitationRequest;
        if (typeof request.id === "string" && typeof request.serverId === "string" && typeof request.expiresAt === "number" && request.expiresAt > Date.now()) {
          await this.writeLifecycle({ id: request.id, serverId: request.serverId, status: "recovered_expired" });
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async request(serverId: string, params: { mode?: "form" | "url"; message: string; requestedSchema?: Record<string, unknown>; url?: string; elicitationId?: string }, signal?: AbortSignal): Promise<ElicitationResult> {
    await this.load();
    if (signal?.aborted) throw signal.reason ?? new Error("MCP elicitation cancelled");
    const now = Date.now();
    const request: ElicitationRequest = { id: randomUUID(), serverId, mode: params.mode ?? "form", message: params.message.slice(0, 8_192), ...(params.requestedSchema ? { requestedSchema: boundedSchema(params.requestedSchema) } : {}), ...(params.url ? { url: params.url } : {}), ...(params.elicitationId ? { elicitationId: params.elicitationId } : {}), createdAt: now, expiresAt: now + this.timeoutMs };
    await this.writeLifecycle({ id: request.id, serverId, status: "pending", request });
    return new Promise<ElicitationResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request.id); void this.writeLifecycle({ id: request.id, serverId, status: "expired" }); reject(new Error(`MCP elicitation timeout (${this.timeoutMs}ms)`)); }, this.timeoutMs);
      const entry: Pending = { request, resolve: (result) => { clearTimeout(timer); this.pending.delete(request.id); void this.writeLifecycle({ id: request.id, serverId, status: `resolved:${result.action}` }); resolve(result); }, reject: (error) => { clearTimeout(timer); this.pending.delete(request.id); void this.writeLifecycle({ id: request.id, serverId, status: "cancelled" }); reject(error); }, timer };
      this.pending.set(request.id, entry);
      const abort = () => entry.reject(signal?.reason ?? new Error("MCP elicitation cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const resolveEntry = entry.resolve; const rejectEntry = entry.reject;
      entry.resolve = (result) => { cleanup(); resolveEntry(result); }; entry.reject = (error) => { cleanup(); rejectEntry(error); };
    });
  }

  list(): ElicitationRequest[] { return [...this.pending.values()].map(({ request }) => structuredClone(request)); }
  resolve(id: string, result: ElicitationResult): void {
    const entry = this.pending.get(id); if (!entry) throw new Error(`MCP elicitation 不存在或已结束: ${id}`);
    validateResult(entry.request, result); entry.resolve(structuredClone(result));
  }
  cancel(id: string, reason = "MCP elicitation cancelled"): void { const entry = this.pending.get(id); if (!entry) throw new Error(`MCP elicitation 不存在或已结束: ${id}`); entry.reject(new Error(reason)); }
  async close(): Promise<void> { for (const [id, entry] of this.pending) { entry.reject(new Error("MCP elicitation broker closed")); this.pending.delete(id); } await this.persistQueue; }

  private async writeLifecycle(value: Record<string, unknown>): Promise<void> {
    if (!this.filePath) return;
    const write = async () => {
      await fs.mkdir(path.dirname(this.filePath!), { recursive: true });
      let rows: unknown[] = [];
      try { rows = JSON.parse(await fs.readFile(this.filePath!, "utf8")) as unknown[]; if (!Array.isArray(rows)) rows = []; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      rows.push({ timestamp: Date.now(), ...value }); if (rows.length > 10_000) rows = rows.slice(-10_000);
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`; await fs.writeFile(temp, JSON.stringify(rows), { encoding: "utf8", mode: 0o600 }); await fs.rename(temp, this.filePath!);
    };
    this.persistQueue = this.persistQueue.then(write, write); return this.persistQueue;
  }
}

function boundedSchema(value: Record<string, unknown>): Record<string, unknown> { const text = JSON.stringify(value); if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("MCP elicitation schema 超过 64KiB"); return structuredClone(value); }
function validateResult(request: ElicitationRequest, result: ElicitationResult): void {
  if (!result || !["accept", "decline", "cancel"].includes(result.action)) throw new Error("MCP elicitation action 无效");
  if (result.action !== "accept") return;
  if (request.mode === "url" && result.content !== undefined) throw new Error("URL elicitation 不接受 form content");
  if (result.content && Object.keys(result.content).length > 100) throw new Error("MCP elicitation content 字段过多");
}
