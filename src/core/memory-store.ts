import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

export type MemoryKind = "user" | "feedback" | "project" | "reference";
export interface MemoryRecord { id: string; kind: MemoryKind; content: string; provenance: string; confidence: number; updatedAt: number; deletedAt?: number }
export interface MemoryCandidate { id: string; kind: MemoryKind; content: string; provenance: string; confidence: number; createdAt: number; status: "pending" | "accepted" | "duplicate" | "rejected"; memoryId?: string }
export interface MemoryConsolidationResult { accepted: MemoryRecord[]; duplicates: MemoryCandidate[]; rejected: MemoryCandidate[] }

/** SQLite source of truth for durable memory; MEMORY.md remains a derived view. */
export class MemoryStore {
  private readonly db: DatabaseSync;
  constructor(filePath: string, private readonly derivedPath = path.join(path.dirname(filePath), "MEMORY.md")) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL, provenance TEXT NOT NULL, confidence REAL NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER); CREATE TABLE IF NOT EXISTS memory_candidates (id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL, normalized TEXT NOT NULL, provenance TEXT NOT NULL, confidence REAL NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, memory_id TEXT); CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status,created_at)");
  }
  upsert(input: Omit<MemoryRecord, "id" | "updatedAt"> & { id?: string }): MemoryRecord {
    if (!isMemoryKind(input.kind)) throw new Error(`memory kind 无效: ${String(input.kind)}`);
    if (!input.content.trim() || Buffer.byteLength(input.content, "utf8") > 64 * 1024) throw new Error("memory content 必须为 1..65536 bytes");
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("memory confidence 必须在 0..1");
    if (!input.provenance.trim()) throw new Error("memory provenance 不能为空");
    const record: MemoryRecord = { ...input, id: input.id ?? randomUUID(), updatedAt: Date.now() };
    this.writeRecord(record);
    this.writeDerivedIndex();
    return record;
  }
  search(query: string, kind?: MemoryKind): MemoryRecord[] {
    const rows = this.db.prepare("SELECT id,kind,content,provenance,confidence,updated_at as updatedAt,deleted_at as deletedAt FROM memory WHERE deleted_at IS NULL AND instr(lower(content), lower(?)) > 0 AND (? IS NULL OR kind = ?) ORDER BY confidence DESC, updated_at DESC LIMIT 50").all(query, kind ?? null, kind ?? null) as unknown as MemoryRecord[];
    return rows;
  }
  relevant(query: string, kind?: MemoryKind, limit = 8): MemoryRecord[] {
    const terms = [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))].slice(0, 12);
    if (terms.length === 0) return [];
    const rows = this.db.prepare(`SELECT id,kind,content,provenance,confidence,updated_at as updatedAt,deleted_at as deletedAt FROM memory WHERE deleted_at IS NULL AND (? IS NULL OR kind = ?) AND (${terms.map(() => "instr(lower(content), ?) > 0").join(" OR ")}) ORDER BY confidence DESC, updated_at DESC LIMIT ?`).all(kind ?? null, kind ?? null, ...terms, limit) as unknown as MemoryRecord[];
    return rows;
  }
  extract(input: { text: string; kind: MemoryKind; provenance: string; confidence?: number }): MemoryCandidate[] {
    if (!isMemoryKind(input.kind)) throw new Error(`memory kind 无效: ${String(input.kind)}`);
    if (!input.text.trim() || Buffer.byteLength(input.text, "utf8") > 256 * 1024) throw new Error("memory extract text 必须为 1..262144 bytes");
    if (!input.provenance.trim()) throw new Error("memory candidate provenance 不能为空");
    const confidence = input.confidence ?? 0.6;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("memory confidence 必须在 0..1");
    const statements = input.text.split(/(?:\r?\n)+|(?<=[。！？.!?])\s+/u).map((value) => value.trim()).filter((value) => value.length >= 4 && Buffer.byteLength(value, "utf8") <= 64 * 1024).slice(0, 100);
    const insert = this.db.prepare("INSERT INTO memory_candidates(id,kind,content,normalized,provenance,confidence,created_at,status,memory_id) VALUES(?,?,?,?,?,?,?,?,NULL)");
    return statements.map((content) => {
      const candidate: MemoryCandidate = { id: randomUUID(), kind: input.kind, content, provenance: input.provenance, confidence, createdAt: Date.now(), status: "pending" };
      insert.run(candidate.id, candidate.kind, candidate.content, normalize(candidate.content), candidate.provenance, candidate.confidence, candidate.createdAt, candidate.status);
      return candidate;
    });
  }
  candidates(status?: MemoryCandidate["status"]): MemoryCandidate[] {
    const rows = this.db.prepare("SELECT id,kind,content,provenance,confidence,created_at as createdAt,status,memory_id as memoryId FROM memory_candidates WHERE (? IS NULL OR status = ?) ORDER BY created_at,id").all(status ?? null, status ?? null) as unknown as MemoryCandidate[];
    return rows;
  }
  consolidate(ids?: readonly string[]): MemoryConsolidationResult {
    const candidates = this.candidates("pending").filter((candidate) => !ids || ids.includes(candidate.id));
    const accepted: MemoryRecord[] = []; const duplicates: MemoryCandidate[] = []; const rejected: MemoryCandidate[] = [];
    const find = this.db.prepare("SELECT id,kind,content,provenance,confidence,updated_at as updatedAt,deleted_at as deletedAt FROM memory WHERE deleted_at IS NULL AND kind = ? AND lower(trim(content)) = lower(trim(?)) LIMIT 1");
    const updateCandidate = this.db.prepare("UPDATE memory_candidates SET status = ?, memory_id = ? WHERE id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        if (candidate.confidence < 0.25) { candidate.status = "rejected"; updateCandidate.run("rejected", null, candidate.id); rejected.push(candidate); continue; }
        const existing = find.get(candidate.kind, candidate.content) as unknown as MemoryRecord | undefined;
        if (existing) {
          const provenance = mergeProvenance(existing.provenance, candidate.provenance);
          const confidence = Math.max(existing.confidence, candidate.confidence);
          this.db.prepare("UPDATE memory SET provenance = ?, confidence = ?, updated_at = ? WHERE id = ?").run(provenance, confidence, Date.now(), existing.id);
          candidate.status = "duplicate"; candidate.memoryId = existing.id; updateCandidate.run("duplicate", existing.id, candidate.id); duplicates.push(candidate); continue;
        }
        const memory: MemoryRecord = { id: randomUUID(), kind: candidate.kind, content: candidate.content, provenance: candidate.provenance, confidence: candidate.confidence, updatedAt: Date.now() };
        this.writeRecord(memory);
        candidate.status = "accepted"; candidate.memoryId = memory.id; updateCandidate.run("accepted", memory.id, candidate.id); accepted.push(memory);
      }
      this.db.exec("COMMIT"); this.writeDerivedIndex();
    } catch (error) { this.db.exec("ROLLBACK"); this.writeDerivedIndex(); throw error; }
    return { accepted, duplicates, rejected };
  }
  fingerprint(): string {
    const rows = this.db.prepare("SELECT id,kind,content,provenance,confidence,updated_at as updatedAt FROM memory WHERE deleted_at IS NULL ORDER BY id").all();
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
  delete(id: string): void { this.db.prepare("UPDATE memory SET deleted_at = ? WHERE id = ?").run(Date.now(), id); this.writeDerivedIndex(); }
  close(): void { this.db.close(); }
  rebuildDerivedIndex(): void { this.writeDerivedIndex(); }
  private writeRecord(record: MemoryRecord): void {
    this.db.prepare("INSERT INTO memory(id,kind,content,provenance,confidence,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,content=excluded.content,provenance=excluded.provenance,confidence=excluded.confidence,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at").run(record.id, record.kind, record.content, record.provenance, record.confidence, record.updatedAt, record.deletedAt ?? null);
  }
  private writeDerivedIndex(): void {
    const rows = this.db.prepare("SELECT kind,content,provenance,confidence,updated_at as updatedAt FROM memory WHERE deleted_at IS NULL ORDER BY kind,confidence DESC,updated_at DESC").all() as unknown as Array<Omit<MemoryRecord, "id">>;
    const lines = ["# Agent Memory", "", "> Derived from memory.sqlite. Do not edit manually.", ""];
    for (const kind of ["user", "feedback", "project", "reference"] as const) {
      lines.push(`## ${kind}`, "");
      const group = rows.filter((row) => row.kind === kind);
      if (group.length === 0) lines.push("- (none)", "");
      else for (const row of group) lines.push(`- ${row.content} (confidence=${row.confidence.toFixed(2)}; provenance=${row.provenance})`);
      lines.push("");
    }
    const temporary = `${this.derivedPath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.derivedPath), { recursive: true });
    fs.writeFileSync(temporary, `${lines.join("\n").trimEnd()}\n`, "utf8");
    fs.renameSync(temporary, this.derivedPath);
  }
}

function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim(); }
function mergeProvenance(left: string, right: string): string { return [...new Set([...left.split(" | "), ...right.split(" | ")].filter(Boolean))].join(" | "); }
function isMemoryKind(value: unknown): value is MemoryKind { return value === "user" || value === "feedback" || value === "project" || value === "reference"; }
