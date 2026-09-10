import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ConfigDiagnostic } from "./layered-config.js";
import { ScopedContextFileSystem, type ContextFileSystem } from "./context-filesystem.js";

const DEFAULT_ROOT_MARKERS = [".git"];
const DEFAULT_BUDGET_BYTES = 32 * 1_024;

export interface InstructionEntry {
  id: string;
  kind: "agents_md";
  sourcePath: string;
  canonicalPath: string;
  environmentId: string;
  scopeCwd: string;
  content: string;
  byteLength: number;
  truncated: boolean;
  contentHash: string;
}

export interface InstructionSnapshot {
  entries: readonly InstructionEntry[];
  totalBytes: number;
  fingerprint: string;
  diagnostics: readonly ConfigDiagnostic[];
}

export interface InstructionLoadOptions {
  cwd: string;
  projectRoot?: string;
  projectRootMarkers?: readonly string[];
  fallbackFilenames?: readonly string[];
  budgetBytes?: number;
  trusted?: boolean;
  environmentId?: string;
  fileSystem?: ContextFileSystem;
}

export interface AgentInstructionFragment {
  role: "user";
  type: "agents_md.instructions" | "agents_md.replacement" | "agents_md.removal";
  source: string;
  text: string;
  hash: string;
  id: string;
  replacesHash?: string;
}

export function discoverAgentMemories(cwd: string): string[] {
  return discoverInstructionFiles({ cwd }).files;
}

export function loadAgentMemories(cwd: string, budgetBytes = DEFAULT_BUDGET_BYTES): string {
  return loadInstructionSnapshot({ cwd, budgetBytes }).entries.map((entry) => entry.content).join("\n\n");
}

export function loadInstructionSnapshot(options: InstructionLoadOptions): InstructionSnapshot {
  const diagnostics: ConfigDiagnostic[] = [];
  const trusted = options.trusted ?? true;
  if (!trusted) {
    diagnostics.push({ severity: "warning", code: "untrusted_project_instructions", message: "项目未受信任，AGENTS 指令未读取" });
    return snapshot([], diagnostics);
  }

  const discovered = discoverInstructionFiles(options);
  const io = discovered.fileSystem;
  diagnostics.push(...discovered.diagnostics);
  const budget = positiveInteger(options.budgetBytes ?? DEFAULT_BUDGET_BYTES, "AGENTS byte budget");
  const entries: InstructionEntry[] = [];
  let used = 0;
  for (const sourcePath of discovered.files) {
    const raw = io.readBytes(sourcePath);
    const remaining = Math.max(0, budget - used);
    if (remaining === 0 && raw.byteLength > 0) {
      diagnostics.push({
        severity: "warning", code: "agents_budget_omitted",
        message: `AGENTS 指令超过 ${budget} 字节预算，后续文件已省略`, sourcePath,
      });
      break;
    }
    const accepted = raw.subarray(0, remaining);
    const truncated = accepted.byteLength < raw.byteLength;
    const content = new TextDecoder("utf-8", { fatal: false }).decode(accepted);
    const canonicalPath = io.realpath(sourcePath);
    entries.push({
      id: hash(canonicalPath), kind: "agents_md", sourcePath, canonicalPath,
      environmentId: options.environmentId ?? "local", scopeCwd: path.resolve(options.cwd),
      content, byteLength: accepted.byteLength, truncated, contentHash: hash(accepted),
    });
    used += accepted.byteLength;
    if (truncated) {
      diagnostics.push({
        severity: "warning", code: "agents_budget_truncated",
        message: `AGENTS 指令超过 ${budget} 字节预算，已截断`, sourcePath,
      });
      break;
    }
  }
  return snapshot(entries, diagnostics);
}

export function loadAgentInstructionFragments(cwd: string, budgetBytes = DEFAULT_BUDGET_BYTES): AgentInstructionFragment[] {
  return instructionFragments(loadInstructionSnapshot({ cwd, budgetBytes }));
}

export function instructionFragments(current: InstructionSnapshot, previous?: InstructionSnapshot): AgentInstructionFragment[] {
  const prior = new Map((previous?.entries ?? []).map((entry) => [entry.id, entry]));
  const next = new Map(current.entries.map((entry) => [entry.id, entry]));
  const result: AgentInstructionFragment[] = [];
  for (const entry of current.entries) {
    const old = prior.get(entry.id);
    if (old?.contentHash === entry.contentHash) continue;
    const type = old ? "agents_md.replacement" : "agents_md.instructions";
    const replacement = old ? ` replaces="${old.contentHash}"` : "";
    const text = `<agents_md source="${escapeAttribute(entry.sourcePath)}" hash="${entry.contentHash}"${replacement}>\n${entry.content}\n</agents_md>`;
    result.push({
      role: "user", type, source: entry.sourcePath, text, hash: hash(text), id: entry.id,
      ...(old ? { replacesHash: old.contentHash } : {}),
    });
  }
  for (const entry of previous?.entries ?? []) {
    if (next.has(entry.id)) continue;
    const text = `<agents_md_removed source="${escapeAttribute(entry.sourcePath)}" hash="${entry.contentHash}" />`;
    result.push({ role: "user", type: "agents_md.removal", source: entry.sourcePath, text, hash: hash(text), id: entry.id, replacesHash: entry.contentHash });
  }
  return result;
}

function discoverInstructionFiles(options: InstructionLoadOptions): { files: string[]; diagnostics: ConfigDiagnostic[]; fileSystem: ContextFileSystem } {
  const cwd = path.resolve(options.cwd);
  const discoveryIo = options.fileSystem ?? new ScopedContextFileSystem([path.parse(cwd).root]);
  const root = path.resolve(options.projectRoot ?? findProjectRoot(cwd, options.projectRootMarkers ?? DEFAULT_ROOT_MARKERS, discoveryIo));
  const io = options.fileSystem ?? new ScopedContextFileSystem([root]);
  if (!isWithin(root, cwd)) throw new Error(`AGENTS cwd 不在项目根目录内: ${cwd}`);
  const fallback = validateFilenames(options.fallbackFilenames ?? []);
  const candidates = [...new Set(["AGENTS.override.md", "AGENTS.md", ...fallback])];
  const files: string[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  for (const directory of directoryChain(root, cwd)) {
    const selected = candidates.map((name) => path.join(directory, name)).find((candidate) => io.isFile(candidate));
    if (!selected) continue;
    const canonicalPath = io.realpath(selected);
    if (!isWithin(root, canonicalPath)) {
      diagnostics.push({ severity: "error", code: "agents_path_escape", message: "AGENTS 文件解析后越出项目根目录", sourcePath: selected });
      continue;
    }
    files.push(path.resolve(selected));
  }
  return { files, diagnostics, fileSystem: io };
}

function directoryChain(root: string, cwd: string): string[] {
  const result = [root];
  let current = root;
  while (!samePath(current, cwd)) {
    const relative = path.relative(current, cwd);
    const next = relative.split(path.sep)[0];
    if (!next || next === "..") break;
    current = path.join(current, next);
    result.push(current);
  }
  return result;
}

function findProjectRoot(cwd: string, markers: readonly string[], io: ContextFileSystem): string {
  if (markers.length === 0) return cwd;
  let current = cwd;
  for (;;) {
    if (markers.some((marker) => io.exists(path.join(current, marker)))) return current;
    const parent = path.dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function snapshot(entries: InstructionEntry[], diagnostics: ConfigDiagnostic[]): InstructionSnapshot {
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  const fingerprint = hash(entries.map(({ id, canonicalPath, contentHash, byteLength, truncated }) => ({ id, canonicalPath, contentHash, byteLength, truncated })));
  return Object.freeze({ entries: Object.freeze(entries), totalBytes, fingerprint, diagnostics: Object.freeze(diagnostics) });
}

function validateFilenames(values: readonly string[]): string[] {
  for (const value of values) {
    if (!value || value === "." || value === ".." || path.isAbsolute(value) || value.includes("/") || value.includes("\\")) {
      throw new Error(`AGENTS fallback 必须是安全文件名: ${value}`);
    }
  }
  return [...new Set(values)];
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`);
  return value;
}
function samePath(left: string, right: string): boolean { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function escapeAttribute(value: string): string { return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function hash(value: string | Buffer | unknown): string {
  const input = typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value);
  return createHash("sha256").update(input).digest("hex");
}
