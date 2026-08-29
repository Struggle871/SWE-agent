import path from "node:path";
import type { ToolDecision, ToolRisk } from "../tools/preview.js";
import type { WorkspacePolicy } from "./workspace-policy.js";

export interface CommandAssessment {
  /** 命令语义要求的最低决策；权限策略只能收紧，不能放宽。 */
  minimumDecision: ToolDecision;
  risk: ToolRisk;
  reasons: string[];
}

export interface CommandAnalyzer {
  analyze(command: string, cwd: string): Promise<CommandAssessment>;
}

const READ_ONLY_COMMANDS = /^(?:dir|ls|pwd|echo\b|type\b|cat\b|head\b|tail\b|findstr\b|grep\b|rg\b|get-childitem\b|get-content\b|git\s+(?:status|diff|log|show)\b)/i;
const DESTRUCTIVE = /(?:^|[;&|]\s*)(?:rm\b|rmdir\b|del\b|erase\b|remove-item\b|format\b|mkfs\b|diskpart\b|git\s+(?:reset|clean|checkout)\b|chmod\b|chown\b)/i;
const SEVERE = /(?:rm\s+-rf\s+(?:\/|~|\$HOME)|format\s+[a-z]:|mkfs\b|git\s+clean\s+-[^\s]*f[^\s]*d)/i;
const NETWORK = /\b(?:curl|wget|invoke-webrequest|irm|iwr|npm\s+(?:install|i)|pnpm\s+(?:install|add)|yarn\s+add|pip\s+install)\b/i;
const DYNAMIC = /(?:\$\(|`[^`]+`|invoke-expression|\biex\b|\*|\?|%[A-Za-z_][A-Za-z0-9_]*%|\$env:)/i;
const SCRIPT_EXECUTION = /(?:^|\s)(?:powershell|pwsh|bash|sh|cmd)(?:\.exe)?\s+(?:-[a-z]+\s+)*[^\s]/i;

export class DefaultCommandAnalyzer implements CommandAnalyzer {
  constructor(private workspacePolicy: WorkspacePolicy) {}

  async analyze(command: string, cwd: string): Promise<CommandAssessment> {
    const trimmed = command.trim();
    if (!trimmed) return { minimumDecision: "deny", risk: "execute", reasons: ["命令为空"] };
    if (SEVERE.test(trimmed)) return { minimumDecision: "deny", risk: "destructive", reasons: ["命令可能破坏工作区或系统数据"] };

    const reasons: string[] = [];
    let risk: ToolRisk = READ_ONLY_COMMANDS.test(trimmed) ? "read" : "execute";
    let decision: ToolDecision = risk === "read" ? "allow" : "ask";

    if (DESTRUCTIVE.test(trimmed)) {
      risk = "destructive";
      decision = "ask";
      reasons.push("包含删除、覆盖、权限修改或 Git 工作树重写操作");
    }
    if (NETWORK.test(trimmed)) {
      risk = "network";
      decision = "ask";
      reasons.push("包含网络访问或依赖安装");
    }
    if (/[|><&]/.test(trimmed)) {
      decision = "ask";
      reasons.push("包含管道、重定向或后台执行符号");
    }
    if (DYNAMIC.test(trimmed)) {
      decision = "ask";
      reasons.push("命令目标包含动态展开，无法完全静态确定");
    }
    if (SCRIPT_EXECUTION.test(trimmed)) {
      decision = "ask";
      reasons.push("包含脚本或子 shell 执行");
    }

    const cdTargets = extractCdTargets(trimmed);
    for (const target of cdTargets) {
      try {
        await this.workspacePolicy.resolve(path.resolve(cwd, stripQuotes(target)), "read");
      } catch {
        return { minimumDecision: "deny", risk: "execute", reasons: [`cd 目标越出工作区: ${target}`] };
      }
      decision = "ask";
      reasons.push(`命令会改变终端目录: ${target}`);
    }

    for (const target of extractPathReferences(trimmed)) {
      try {
        await this.workspacePolicy.resolve(path.resolve(cwd, stripQuotes(target)), "read");
      } catch {
        return { minimumDecision: "deny", risk, reasons: [`命令引用工作区外路径: ${target}`] };
      }
    }

    if (reasons.length === 0) reasons.push(risk === "read" ? "只读命令" : "执行任意命令需要批准");
    return { minimumDecision: decision, risk, reasons };
  }
}

function extractCdTargets(command: string): string[] {
  const targets: string[] = [];
  const re = /(?:^|[\s"';&|])cd(?:\s+\/d)?\s+([^;&|\r\n"']+)/gi;
  for (const match of command.matchAll(re)) targets.push(match[1].trim());
  const alternative = /(?:^|[\s"';&|])(?:pushd|set-location|sl)\s+([^;&|\r\n"']+)/gi;
  for (const match of command.matchAll(alternative)) targets.push(match[1].trim());
  return targets;
}

function extractPathReferences(command: string): string[] {
  const references: string[] = [];
  for (const match of command.matchAll(/[a-zA-Z]:[\\/][^\s"';&|<>]*/g)) references.push(match[0]);
  for (const match of command.matchAll(/(?:^|\s)(\.\.(?:[\\/][^\s"';&|<>]*)?)/g)) references.push(match[1]);
  if (process.platform !== "win32") {
    for (const match of command.matchAll(/(?:^|\s)(\/(?!dev\/null)[^\s"';&|<>]*)/g)) references.push(match[1]);
  }
  return [...new Set(references)];
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
