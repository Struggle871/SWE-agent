import path from "node:path";
import type { ToolDecision, ToolRisk } from "../tools/preview.js";
import type { WorkspacePolicy } from "./workspace-policy.js";
import { parseShell, type ShellCommandChain, type ShellCommandNode, type ShellDialect, type ShellCommand } from "./shell-ast.js";
import { defaultShellDialect, type ShellOperator } from "./shell-tokenizer.js";

export interface CommandNodeAssessment {
  command: string;
  decision: ToolDecision;
  risk: ToolRisk;
  reasons: string[];
  affectedPaths: string[];
  start: number;
  end: number;
}

export interface CommandAssessment {
  minimumDecision: ToolDecision;
  risk: ToolRisk;
  reasons: string[];
  ast?: ShellCommandChain;
  nodes?: CommandNodeAssessment[];
  affectedPaths?: string[];
  requires?: { filesystem: "workspace"; subprocess: true; workingDirectory: true; environment: "filtered"; timeout: true; cancellation: true; network: boolean };
}

export interface CommandAnalyzer {
  analyze(command: string, cwd: string): Promise<CommandAssessment>;
}

const READ_ONLY_COMMANDS = new Set(["dir", "ls", "pwd", "echo", "type", "cat", "head", "tail", "findstr", "grep", "rg", "get-childitem", "get-content"]);
const DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "del", "erase", "remove-item", "format", "mkfs", "diskpart", "chmod", "chown"]);
const NETWORK_COMMANDS = new Set(["curl", "wget", "invoke-webrequest", "irm", "iwr"]);
const INSTALLERS = /^(npm|pnpm|yarn|pip)(?:\.exe)?$/i;
const SCRIPT_INTERPRETERS = new Set(["powershell", "pwsh", "bash", "sh", "cmd", "cmd.exe", "node", "python", "python3"]);

function isReadOnlyCommand(executable: string, args: string[]): boolean {
  if (READ_ONLY_COMMANDS.has(executable)) return true;
  return executable === "git" && /^(status|diff|log|show)$/i.test(args[0] ?? "");
}

export class DefaultCommandAnalyzer implements CommandAnalyzer {
  constructor(private workspacePolicy: WorkspacePolicy, private readonly dialect: ShellDialect = defaultShellDialect()) {}

  async analyze(command: string, cwd: string): Promise<CommandAssessment> {
    if (!command.trim()) return denied("命令为空");
    let ast: ShellCommandChain;
    try { ast = parseShell(command, this.dialect); }
    catch (error) { return { minimumDecision: "ask", risk: "execute", reasons: [`Shell 语义无法确定: ${error instanceof Error ? error.message : String(error)}`], requires: sandboxRequirements(false) }; }
    const nodes: CommandNodeAssessment[] = [];
    for (const node of flatten(ast.commands)) nodes.push(await this.assessNode(node, cwd));
    const reasons = nodes.flatMap((node) => node.reasons);
    for (const relation of collectOperators(ast)) reasons.push(`控制关系: ${relation.operator}（位置 ${relation.start}）`);
    const affectedPaths = [...new Set(nodes.flatMap((node) => node.affectedPaths))];
    return { minimumDecision: mergeDecision(nodes.map((node) => node.decision)), risk: highestRisk(nodes.map((node) => node.risk)), reasons: [...new Set(reasons)], ast, nodes, affectedPaths, requires: sandboxRequirements(nodes.some((node) => node.risk === "network")) };
  }

  private async assessNode(node: ShellCommand, cwd: string): Promise<CommandNodeAssessment> {
    const executable = node.argv[0]?.value.toLowerCase() ?? "";
    const args = node.argv.slice(1).map((word) => word.value);
    const reasons: string[] = [];
    let decision: ToolDecision = isReadOnlyCommand(executable, args) ? "allow" : "ask";
    let risk: ToolRisk = isReadOnlyCommand(executable, args) ? "read" : "execute";
    const affectedPaths: string[] = [];
    if (!executable) reasons.push("空子命令无法静态分析");
    if (DESTRUCTIVE_COMMANDS.has(executable)) {
      risk = "destructive"; decision = "ask"; reasons.push("包含删除、覆盖、格式化或权限修改操作");
      if (isSevere(executable, args)) { decision = "deny"; reasons.push("命令可能破坏工作区或系统数据"); }
    }
    if (executable === "git" && /^(reset|clean|checkout)$/i.test(args[0] ?? "")) {
      risk = "destructive";
      decision = "ask";
      reasons.push("包含 Git 工作树重写操作");
      if (args[0]?.toLowerCase() === "clean" && args.some((arg) => /f/.test(arg) && /d/.test(arg))) {
        decision = "deny";
        reasons.push("命令可能破坏工作区或系统数据");
      }
    }
    if (NETWORK_COMMANDS.has(executable) || (INSTALLERS.test(executable) && /^(install|i|add)$/i.test(args[0] ?? ""))) {
      risk = "network"; decision = mergeDecision([decision, "ask"]); reasons.push("包含网络访问或依赖安装");
    }
    if (SCRIPT_INTERPRETERS.has(executable) || node.dynamic) {
      decision = mergeDecision([decision, "ask"]); reasons.push(node.dynamic ? "包含变量、glob 或命令替换，目标无法静态确定" : "包含脚本解释器或子进程执行");
    }
    for (const word of node.argv.slice(1)) {
      if (word.dynamic) continue;
      for (const reference of pathReferences(word.value)) {
        try { affectedPaths.push((await this.workspacePolicy.resolve(path.resolve(cwd, stripQuotes(reference)), "read")).canonicalPath); }
        catch { decision = "deny"; reasons.push(`命令引用工作区外路径: ${reference}`); }
      }
    }
    for (const redirect of node.redirects) {
      decision = mergeDecision([decision, "ask"]); risk = risk === "destructive" ? risk : "execute"; reasons.push(`包含${redirect.operator}重定向，可能改变文件状态`);
      if (redirect.target && !redirect.target.dynamic) {
        try { affectedPaths.push((await this.workspacePolicy.resolve(path.resolve(cwd, redirect.target.value), redirect.operator.includes(">") ? "write" : "read")).canonicalPath); }
        catch { decision = "deny"; reasons.push(`重定向目标越出工作区: ${redirect.target.value}`); }
      }
    }
    if (reasons.length === 0) reasons.push(decision === "allow" ? "只读子命令" : "执行命令需要批准");
    return { command: renderNode(node), decision, risk, reasons, affectedPaths: [...new Set(affectedPaths)], start: node.start, end: node.end };
  }
}

export const StructuredCommandAnalyzer = DefaultCommandAnalyzer;

function flatten(nodes: ShellCommandNode[]): ShellCommand[] { return nodes.flatMap((node) => node.kind === "command" ? [node] : flatten(node.body.commands)); }
function collectOperators(ast: ShellCommandChain): Array<{ operator: ShellOperator; start: number }> {
  const relations = ast.operators.map((operator, index) => ({ operator, start: ast.tokens[index]?.start ?? 0 }));
  for (const node of ast.commands) if (node.kind === "group") relations.push(...collectOperators(node.body));
  return relations;
}
function mergeDecision(decisions: ToolDecision[]): ToolDecision { return decisions.includes("deny") ? "deny" : decisions.includes("ask") ? "ask" : "allow"; }
function highestRisk(risks: ToolRisk[]): ToolRisk { const order: ToolRisk[] = ["read", "execute", "write", "network", "destructive"]; return risks.reduce((a, b) => order.indexOf(b) > order.indexOf(a) ? b : a, "read"); }
function sandboxRequirements(network: boolean): CommandAssessment["requires"] { return { filesystem: "workspace", subprocess: true, workingDirectory: true, environment: "filtered", timeout: true, cancellation: true, network }; }
function denied(reason: string): CommandAssessment { return { minimumDecision: "deny", risk: "execute", reasons: [reason], requires: sandboxRequirements(false) }; }
function isSevere(executable: string, args: string[]): boolean { return (executable === "rm" && args.some((arg) => /^-.*r/.test(arg)) && args.some((arg) => /^(?:[\\/]|~|\$HOME)$/.test(arg))) || executable === "format" && /^[a-z]:?$/i.test(args[0] ?? "") || executable === "mkfs" || executable === "diskpart"; }
function pathReferences(value: string): string[] { return /^(?:\.\.(?:[\\/]|$)|[\\/]|[a-z]:[\\/])/i.test(value) ? [value] : []; }
function stripQuotes(value: string): string { return value.replace(/^['"]|['"]$/g, ""); }
function renderNode(node: ShellCommand): string { return node.argv.map((word) => word.quoted ? JSON.stringify(word.value) : word.value).join(" "); }
