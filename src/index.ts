import { loadAgentMemories } from "./config/agents-md.js";
import { loadLayeredConfig } from "./config/layered-config.js";
import { AgentSession } from "./core/agent-session.js";
import type { AgentEvent } from "./core/events.js";
import { FileStateCache } from "./core/file-state-cache.js";
import { CliApprovalBroker } from "./security/approval-broker.js";
import { AuditTrail } from "./security/audit.js";
import { DefaultCommandAnalyzer } from "./security/command-policy.js";
import { PermissionPolicy } from "./security/permission-policy.js";
import { WorkspacePolicy } from "./security/workspace-policy.js";
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

  const ctx: AgentContext = {
    config,
    registry,
    shell,
    model,
    workspaceRoot: config.workspaceRoot,
    workingMemory: {},
    agentMemories: loadAgentMemories(config.workspaceRoot),
    fileStateCache,
    workspacePolicy,
    commandAnalyzer: new DefaultCommandAnalyzer(workspacePolicy),
    permissionPolicy: new PermissionPolicy(),
    approvalBroker: new CliApprovalBroker(),
    auditTrail: new AuditTrail(`${config.workspaceRoot}/.swe-agent/audit.jsonl`),
  };

  const userRequest = process.argv[2] ?? "列出当前目录内容，然后给出最终结论";

  console.log("=".repeat(60));
  console.log("Minimal SWE Agent");
  console.log(`模型: ${config.useFakeModel ? "FakeModel（演示）" : config.model.model}`);
  console.log(`工作目录: ${config.workspaceRoot}`);
  console.log(`任务: ${userRequest}`);
  if (ctx.agentMemories) console.log(`项目记忆: 已加载 ${ctx.agentMemories.split("\n").length} 行`);
  console.log("=".repeat(60));

  const session = new AgentSession(ctx, onEvent);

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
    await shell.close();
  }
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
