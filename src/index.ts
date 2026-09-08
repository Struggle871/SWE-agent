import { loadAgentInstructionFragments } from "./config/agents-md.js";
import { loadSkillFragments } from "./config/skills.js";
import { loadLayeredConfig } from "./config/layered-config.js";
import { AgentSession } from "./core/agent-session.js";
import type { AgentEvent } from "./core/events.js";
import { FileStateCache } from "./core/file-state-cache.js";
import { CliApprovalBroker } from "./security/approval-broker.js";
import { AuditTrail } from "./security/audit.js";
import { DefaultCommandAnalyzer } from "./security/command-policy.js";
import { PermissionPolicy } from "./security/permission-policy.js";
import { WorkspacePolicy } from "./security/workspace-policy.js";
import { LocalSandboxProvider, UnavailableSandboxProvider, WindowsDockerSandboxProvider } from "./security/sandbox.js";
import { FakeModelClient, OpenAIChatModelClient } from "./model/model-client.js";
import { editFileTool } from "./tools/edit.js";
import { listDirTool, readFileTool, writeFileTool } from "./tools/file-io.js";
import { ToolRegistry } from "./tools/registry.js";
import { searchContentTool, searchFilesTool } from "./tools/search.js";
import { readTerminalOutputTool, runCommandTool, ShellSession } from "./tools/terminal.js";
import type { AgentContext, ModelClient } from "./types.js";

async function main() {
  const config = await loadLayeredConfig();

  const model: ModelClient = config.useFakeModel
    ? new FakeModelClient()
    : new OpenAIChatModelClient({
        baseUrl: config.model.baseUrl,
        apiKey: config.model.apiKey,
        model: config.model.model,
      });

  const registry = new ToolRegistry();
  registry.register(runCommandTool);
  registry.register(readTerminalOutputTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(listDirTool);
  registry.register(searchFilesTool);
  registry.register(searchContentTool);

  const shell = new ShellSession(config.workspaceRoot);
  const fileStateCache = new FileStateCache();
  const workspacePolicy = await WorkspacePolicy.create({ readableRoots: [config.workspaceRoot] });
  const sandboxProvider = createSandboxProvider(config.workspaceRoot);

  const ctx: AgentContext = {
    config,
    registry,
    shell,
    model,
    workspaceRoot: config.workspaceRoot,
    workingMemory: {},
    contextualFragments: [...loadAgentInstructionFragments(config.workspaceRoot), ...loadSkillFragments(config.workspaceRoot)],
    fileStateCache,
    workspacePolicy,
    commandAnalyzer: new DefaultCommandAnalyzer(workspacePolicy, sandboxProvider.capabilities().shellDialect),
    permissionPolicy: new PermissionPolicy(),
    approvalBroker: new CliApprovalBroker(),
    auditTrail: new AuditTrail(`${config.workspaceRoot}/.swe-agent/audit.jsonl`),
    sandboxProvider,
  };

  const cli = parseCliArguments(process.argv.slice(2));
  const userRequest = cli.request ?? "列出当前目录内容，然后给出最终结论";

  console.log("=".repeat(60));
  console.log("Minimal SWE Agent");
  console.log(`模型: ${config.useFakeModel ? "FakeModel（演示）" : config.model.model}`);
  console.log(`工作目录: ${config.workspaceRoot}`);
  console.log(`任务: ${userRequest}`);
  if (ctx.contextualFragments?.length) console.log(`上下文片段: 已加载 ${ctx.contextualFragments.length} 项`);
  console.log("=".repeat(60));

  const session = cli.resume
    ? await AgentSession.resume(ctx, cli.resume, onEvent)
    : cli.fork
      ? await AgentSession.fork(ctx, cli.fork, { atOrdinal: cli.atOrdinal, reason: "CLI fork" }, onEvent)
      : new AgentSession(ctx, onEvent);
  console.log(`Session: ${session.sessionId}`);
  console.log(`Transcript: ${session.transcriptPath}`);

  try {
    const result = await session.run(userRequest);
    console.log("\n\n最终答案:\n" + result.answer);
    console.log(`\n共执行 ${result.steps} 步。`);
    console.log("\n执行轨迹:");
    for (const s of result.taskTrace) {
      if (s.action.type === "tool_call") {
        const status = s.observation?.isError ? "ERROR" : "OK";
        console.log(`  [${s.index}] ${s.action.toolName}(${JSON.stringify(s.action.toolInput)}) -> ${status}`);
      } else {
        console.log(`  [${s.index}] final_answer: ${s.action.answer}`);
      }
    }
  } finally {
    await session.close();
    await shell.close();
  }
}

interface CliArguments { request?: string; resume?: string; fork?: string; atOrdinal?: number }

function parseCliArguments(args: string[]): CliArguments {
  const result: CliArguments = {};
  const requestParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--resume" || argument === "--fork") {
      const value = args[++index];
      if (!value) throw new Error(`${argument} 需要 session id`);
      if (argument === "--resume") result.resume = value;
      else result.fork = value;
      continue;
    }
    if (argument === "--at") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 0) throw new Error("--at 需要非负 ordinal");
      result.atOrdinal = value;
      continue;
    }
    requestParts.push(argument);
  }
  if (result.resume && result.fork) throw new Error("--resume 与 --fork 不能同时使用");
  if (result.atOrdinal !== undefined && !result.fork) throw new Error("--at 只能与 --fork 一起使用");
  if (requestParts.length > 0) result.request = requestParts.join(" ");
  return result;
}

function createSandboxProvider(root: string) {
  const requestedMode = process.env.SWE_SANDBOX_MODE?.trim().toLowerCase();
  if (requestedMode === "best-effort") return new LocalSandboxProvider(root);
  if (process.platform === "win32") return new WindowsDockerSandboxProvider(root);
  return new UnavailableSandboxProvider();
}

function onEvent(e: AgentEvent): void {
  switch (e.type) {
    case "stream_start":
      process.stdout.write("\n[流式输出] ");
      break;
    case "stream_delta":
      process.stdout.write(e.delta);
      break;
    case "tool_use_started":
      process.stdout.write(`\n[工具] ${e.toolName}\n`);
      break;
    case "tool_use_completed":
      console.log(`[工具] ${e.toolName} ${e.isError ? "失败" : "完成"}`);
      break;
    case "tool_preview":
      console.log(`\n[预览] ${e.preview.summary}`);
      console.log(`风险: ${e.preview.risk} | cwd: ${e.preview.cwd}`);
      if (e.preview.affectedPaths.length > 0) console.log(`路径: ${e.preview.affectedPaths.join(", ")}`);
      if (e.preview.diff) console.log(e.preview.diff);
      console.log(`原因: ${e.preview.reasons.join("；")}`);
      break;
    case "approval_resolved":
      console.log(`[审批] ${e.result.approved ? "已批准" : "已拒绝"} (${e.result.scope})`);
      break;
    default:
      break;
  }
}

main().catch((e) => {
  console.error("Agent 运行失败:", e);
  process.exit(1);
});
