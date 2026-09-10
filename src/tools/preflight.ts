import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentContext } from "../types.js";
import type { ToolSpec } from "./types.js";
import type { ToolDecision, ToolExecutionPreview, ToolPreflightResult, ToolRisk } from "./preview.js";
import { createUnifiedDiff } from "./diff.js";
import { qualifiedName, validateToolInput } from "./registry.js";

const READ_PATH_TOOLS = new Set(["read_file", "list_dir", "search_files", "search_content"]);
const WRITE_PATH_TOOLS = new Set(["write_file", "edit_file"]);

export class ToolPreflight {
  async run(callId: string, tool: ToolSpec, input: Record<string, unknown>, ctx: AgentContext): Promise<ToolPreflightResult> {
    const normalizedInput = validateToolInput(tool.parameters, input);
    const affectedPaths: string[] = [];
    const fileHashes: Record<string, string | null> = {};
    let risk: ToolRisk = tool.isReadOnly ? "read" : "execute";
    let summary = tool.description;
    let command: string | undefined;
    let diff: string | undefined;
    let commandAssessment;

    if (READ_PATH_TOOLS.has(tool.name)) {
      const requested = String(normalizedInput.path ?? ".");
      const target = await ctx.workspacePolicy.resolve(requested, "read");
      normalizedInput.path = target.canonicalPath;
      affectedPaths.push(target.canonicalPath);
      fileHashes[target.canonicalPath] = await hashIfFile(target.canonicalPath);
      summary = `${tool.name}: ${target.canonicalPath}`;
    } else if (WRITE_PATH_TOOLS.has(tool.name)) {
      risk = "write";
      const requested = String(normalizedInput.path ?? "");
      const target = await ctx.workspacePolicy.resolve(requested, "write");
      ctx.workspacePolicy.assertWritableTarget(target);
      normalizedInput.path = target.canonicalPath;
      affectedPaths.push(target.canonicalPath);
      const stale = await ctx.fileStateCache.assertFresh(target.canonicalPath);
      if (stale) throw new ToolValidationError(stale);
      const before = await readIfFile(target.canonicalPath);
      fileHashes[target.canonicalPath] = before === null ? null : hashText(before);
      const after = buildWriteResult(tool.name, normalizedInput, before);
      diff = createUnifiedDiff(path.relative(target.root, target.canonicalPath), before ?? "", after);
      summary = `${tool.name}: ${target.canonicalPath}`;
    } else if (tool.name === "run_command" || tool.runtimeCommand) {
      command = tool.runtimeCommand ?? String(normalizedInput.command ?? "");
      commandAssessment = await ctx.commandAnalyzer.analyze(command, ctx.workspaceRoot);
      risk = commandAssessment.risk;
      affectedPaths.push(...(commandAssessment.affectedPaths ?? []));
      summary = `${qualifiedName(tool)}: ${command}`;
    } else if (tool.name === "read_terminal_output") {
      risk = "read";
      summary = "读取终端缓冲区";
    }

    const policy = ctx.permissionPolicy.decide(risk);
    const analysisDecision = commandAssessment?.minimumDecision ?? "allow";
    const decision = stricterDecision(analysisDecision, policy.decision);
    const reasons = commandAssessment
      ? uniqueReasons([...commandAssessment.reasons, ...policy.reasons])
      : policy.reasons;
    const preview: ToolExecutionPreview = {
      callId,
      toolName: qualifiedName(tool),
      summary,
      risk,
      cwd: ctx.workspaceRoot,
      affectedPaths,
      command,
      diff,
      reasons,
    };
    const permissionFingerprint = hashText(stableStringify({
      tool: qualifiedName(tool),
      input: normalizedInput,
      paths: affectedPaths,
      fileHashes,
      policy: ctx.permissionPolicy.fingerprint(),
      commandAssessment,
      roots: { read: ctx.workspacePolicy.readableRoots, write: ctx.workspacePolicy.writableRoots },
    }));
    return { decision, preview, normalizedInput, permissionFingerprint, fileHashes };
  }
}

export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolValidationError";
  }
}

function buildWriteResult(toolName: string, input: Record<string, unknown>, before: string | null): string {
  if (toolName === "write_file") {
    const content = String(input.content ?? "");
    return input.append === true ? `${before ?? ""}${content}` : content;
  }
  if (before === null) throw new ToolValidationError("edit_file 目标文件不存在");
  const oldString = String(input.old_string ?? "");
  if (!oldString) throw new ToolValidationError("old_string 不能为空");
  const newString = normalizeNewString(String(input.path ?? ""), String(input.new_string ?? ""));
  const count = occurrences(before, oldString);
  if (count === 0) throw new ToolValidationError("old_string 未在文件中找到，请重新读取文件");
  if (count > 1 && input.replace_all !== true) throw new ToolValidationError(`old_string 出现 ${count} 次，不唯一`);
  return input.replace_all === true ? before.split(oldString).join(newString) : before.replace(oldString, () => newString);
}

function normalizeNewString(file: string, value: string): string {
  if (/\.(md|mdx)$/i.test(file)) return value;
  return value.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
}

function occurrences(content: string, value: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += value.length;
  }
  return count;
}

async function readIfFile(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? await fs.readFile(file, "utf8") : null;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

async function hashIfFile(file: string): Promise<string | null> {
  const content = await readIfFile(file);
  return content === null ? null : hashText(content);
}

export function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stricterDecision(left: ToolDecision, right: ToolDecision): ToolDecision {
  const rank = { allow: 0, ask: 1, deny: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)];
}
