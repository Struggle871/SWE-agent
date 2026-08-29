import fs from "node:fs/promises";
import path from "node:path";

export type WorkspaceAccess = "read" | "write";

export interface WorkspacePolicyOptions {
  readableRoots: string[];
  writableRoots?: string[];
}

export interface ResolvedWorkspacePath {
  requestedPath: string;
  absolutePath: string;
  canonicalPath: string;
  root: string;
  exists: boolean;
}

const BYPASS_IMMUNE_SEGMENTS = new Set([".git", ".swe-agent", ".claude", ".codex"]);
const BYPASS_IMMUNE_FILES = new Set([
  ".env",
  ".gitignore",
  ".bashrc",
  ".zshrc",
  "package-lock.json",
]);
const BYPASS_IMMUNE_SUFFIXES = [".claude/settings.json", ".codex/config.toml"];

export class WorkspacePolicy {
  readonly readableRoots: readonly string[];
  readonly writableRoots: readonly string[];

  private constructor(readableRoots: string[], writableRoots: string[]) {
    this.readableRoots = readableRoots;
    this.writableRoots = writableRoots;
  }

  static async create(options: WorkspacePolicyOptions): Promise<WorkspacePolicy> {
    if (options.readableRoots.length === 0) throw new Error("至少需要一个 readable workspace root");
    const readableRoots = await canonicalizeRoots(options.readableRoots);
    const writableRoots = await canonicalizeRoots(options.writableRoots ?? options.readableRoots);
    for (const writable of writableRoots) {
      if (!readableRoots.some((root) => contains(root, writable))) {
        throw new Error(`writable root 不属于 readable roots: ${writable}`);
      }
    }
    return new WorkspacePolicy(readableRoots, writableRoots);
  }

  async resolve(requestedPath: string, access: WorkspaceAccess): Promise<ResolvedWorkspacePath> {
    const raw = requestedPath.trim() || ".";
    rejectAlternateDataStream(raw);
    const base = this.readableRoots[0];
    const absolutePath = path.resolve(base, raw);
    const canonical = await canonicalizeTarget(absolutePath);
    const roots = access === "write" ? this.writableRoots : this.readableRoots;
    const root = roots.find((candidate) => contains(candidate, canonical.canonicalPath));
    if (!root) throw new WorkspacePolicyError("outside_workspace", `路径越出允许的 ${access} 工作区: ${requestedPath}`);
    return { requestedPath, absolutePath, canonicalPath: canonical.canonicalPath, root, exists: canonical.exists };
  }

  assertWritableTarget(target: ResolvedWorkspacePath): void {
    const relative = normalizeForComparison(path.relative(target.root, target.canonicalPath));
    const segments = relative.split("/").filter(Boolean);
    if (segments.some((segment) => BYPASS_IMMUNE_SEGMENTS.has(segment))) {
      throw new WorkspacePolicyError("bypass_immune", `拒绝修改受保护路径: ${target.requestedPath}`);
    }
    if (segments.some((segment) => BYPASS_IMMUNE_FILES.has(segment))) {
      throw new WorkspacePolicyError("bypass_immune", `拒绝修改受保护文件: ${target.requestedPath}`);
    }
    if (BYPASS_IMMUNE_SUFFIXES.some((suffix) => relative === suffix || relative.endsWith(`/${suffix}`))) {
      throw new WorkspacePolicyError("bypass_immune", `拒绝修改受保护配置: ${target.requestedPath}`);
    }
  }

  containsCanonical(candidate: string, access: WorkspaceAccess): boolean {
    const roots = access === "write" ? this.writableRoots : this.readableRoots;
    return roots.some((root) => contains(root, candidate));
  }
}

export class WorkspacePolicyError extends Error {
  constructor(public readonly code: "outside_workspace" | "alternate_data_stream" | "bypass_immune", message: string) {
    super(message);
    this.name = "WorkspacePolicyError";
  }
}

async function canonicalizeRoots(roots: string[]): Promise<string[]> {
  const canonical = await Promise.all(roots.map(async (root) => normalizeAbsolute(await fs.realpath(path.resolve(root)))));
  return [...new Set(canonical.map(normalizeForComparison))];
}

async function canonicalizeTarget(absolutePath: string): Promise<{ canonicalPath: string; exists: boolean }> {
  try {
    return { canonicalPath: normalizeAbsolute(await fs.realpath(absolutePath)), exists: true };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const missing: string[] = [];
  let cursor = absolutePath;
  for (;;) {
    try {
      const parent = normalizeAbsolute(await fs.realpath(cursor));
      return { canonicalPath: normalizeAbsolute(path.join(parent, ...missing.reverse())), exists: false };
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function rejectAlternateDataStream(p: string): void {
  const withoutDrive = /^[a-zA-Z]:/.test(p) ? p.slice(2) : p;
  if (withoutDrive.includes(":")) {
    throw new WorkspacePolicyError("alternate_data_stream", `拒绝 NTFS alternate data stream 路径: ${p}`);
  }
}

function normalizeAbsolute(p: string): string {
  return path.normalize(p);
}

function normalizeForComparison(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contains(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForComparison(root);
  const normalizedCandidate = normalizeForComparison(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
