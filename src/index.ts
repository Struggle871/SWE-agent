import { refreshContextualFragments } from "./config/context-loader.js";
import { ScopedContextFileSystem } from "./config/context-filesystem.js";
import { configExplain, loadConfigLayerStack } from "./config/layered-config.js";
import { AgentSession } from "./core/agent-session.js";
import type { AgentEvent } from "./core/events.js";
import { FileStateCache } from "./core/file-state-cache.js";
import { CliApprovalBroker } from "./security/approval-broker.js";
import { AuditTrail } from "./security/audit.js";
import { DefaultCommandAnalyzer } from "./security/command-policy.js";
import { CONSERVATIVE_PERMISSION_PROFILE, PermissionPolicy } from "./security/permission-policy.js";
import { WorkspacePolicy } from "./security/workspace-policy.js";
import { LocalSandboxProvider, UnavailableSandboxProvider, WindowsDockerSandboxProvider } from "./security/sandbox.js";
import { FakeModelClient, OpenAIChatModelClient } from "./model/model-client.js";
import { editFileTool } from "./tools/edit.js";
import { listDirTool, readFileTool, writeFileTool } from "./tools/file-io.js";
import { ToolRegistry } from "./tools/registry.js";
import { searchContentTool, searchFilesTool } from "./tools/search.js";
import { readTerminalOutputTool, runCommandTool, ShellSession } from "./tools/terminal.js";
import type { AgentContext, ModelClient } from "./types.js";
import { LocalSkillProvider, MarketplaceClient, RemoteSkillProvider, SkillPluginManager, SkillPlatform, SkillScriptAdapter, runSkillScript, skillScriptDefinitions } from "./skills/platform.js";
import { TiktokenSkillTokenizer } from "./skills/tokenizer.js";
import { mcpToolRegistrations } from "./skills/mcp-provider.js";
import { PluginLifecycleManager, MarketplaceIndex } from "./skills/plugin-manager.js";
import { PluginActivationManager } from "./skills/plugin-activation.js";
import { McpCredentialStore } from "./skills/mcp-credentials.js";
import { McpRuntimeManager } from "./skills/mcp-manager.js";
import { McpElicitationBroker } from "./skills/mcp-elicitation.js";
import { createRemoteSkillProviders } from "./skills/remote-provider.js";
import { taskCreateTool, taskGetTool, taskListTool, taskUpdateTool } from "./tools/task-tools.js";
import { listAgentsTool, sendMessageTool, spawnAgentTool, waitAgentTool } from "./tools/agent-tools.js";
import path from "node:path";
import { MemoryStore } from "./core/memory-store.js";
import { Observability } from "./core/observability.js";
import { memoryCandidatesTool, memoryConsolidateTool, memoryDeleteTool, memoryExtractTool, memoryPutTool, memorySearchTool } from "./tools/memory-tools.js";
import { AppServer } from "./server/app-server.js";

async function main() {
  try { process.loadEnvFile(); } catch { /* optional .env compatibility */ }
  const configStack = loadConfigLayerStack();
  const config = configStack.effective;
  const cli = parseCliArguments(process.argv.slice(2));
  if (cli.skillCommand) { await runSkillsCommand(cli.skillCommand, config); return; }
  if (cli.configExplainPath) {
    console.log(JSON.stringify(configExplain(configStack, cli.configExplainPath), null, 2));
    return;
  }

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
  registry.register(taskCreateTool);
  registry.register(taskGetTool);
  registry.register(taskListTool);
  registry.register(taskUpdateTool);
  registry.register(spawnAgentTool);
  registry.register(listAgentsTool);
  registry.register(waitAgentTool);
  registry.register(sendMessageTool);
  registry.register(memoryPutTool);
  registry.register(memorySearchTool);
  registry.register(memoryDeleteTool);
  registry.register(memoryExtractTool);
  registry.register(memoryConsolidateTool);
  registry.register(memoryCandidatesTool);

  const shell = new ShellSession(config.workspaceRoot);
  const pluginLifecycle = new PluginLifecycleManager(config.skills?.installRoot ?? path.join(config.workspaceRoot, ".swe-agent", "plugins"));
  await pluginLifecycle.load();
  const localSkillProvider = new LocalSkillProvider("local", config.workspaceRoot, {
    ...config.skills,
    projectRoot: configStack.projectRoot,
    userRoots: [...(config.skills?.userRoots ?? []), ...(config.skills?.pluginRoots ?? [])],
  });
  const mcpCredentialStore = new McpCredentialStore(path.join(config.workspaceRoot, ".swe-agent", "mcp-credentials.json"));
  const mcpElicitationBroker = new McpElicitationBroker(path.join(config.workspaceRoot, ".swe-agent", "mcp-elicitations.jsonl"));
  const mcpManager = new McpRuntimeManager(path.join(config.workspaceRoot, ".swe-agent", "mcp-servers.json"), config.skills?.mcpServers ?? {}, mcpCredentialStore, mcpElicitationBroker);
  const mcpProviders = [...await mcpManager.initialize()];
  const remoteProviders = createRemoteSkillProviders(config.skills?.remoteProviders);
  const skillProviders = [localSkillProvider, ...mcpProviders, ...remoteProviders];
  const skillPlatform = new SkillPlatform(skillProviders);
  const pluginManager = new SkillPluginManager(config.skills?.pluginRoots ?? []);
  await pluginManager.load();
  for (const registration of skillPlatform.registrations()) registry.registerDefinition(registration);
  for (const registration of await mcpToolRegistrations(mcpProviders)) registry.registerDefinition({ ...registration, source: `mcp-managed:${registration.source}` });
  const fileStateCache = new FileStateCache();
  const workspacePolicy = await WorkspacePolicy.create({ readableRoots: [config.workspaceRoot] });
  const sandboxProvider = createSandboxProvider(config.workspaceRoot, config.sandboxMode);

  const ctx: AgentContext = {
    config,
    registry,
    shell,
    model,
    workspaceRoot: config.workspaceRoot,
    workingMemory: {},
    configStack,
    skillPlatform,
    contextFileSystem: new ScopedContextFileSystem([
      configStack.projectRoot,
      ...(config.skills?.repoRoots ?? []),
      ...(config.skills?.userRoots ?? []),
      ...(config.skills?.systemRoots ?? []),
      ...(config.skills?.adminRoots ?? []),
      ...(config.skills?.pluginRoots ?? []),
    ]),
    fileStateCache,
    workspacePolicy,
    commandAnalyzer: new DefaultCommandAnalyzer(workspacePolicy, sandboxProvider.capabilities().shellDialect),
    permissionPolicy: new PermissionPolicy({ ...CONSERVATIVE_PERMISSION_PROFILE, allowNetwork: config.networkAccess === "allow" }),
    approvalBroker: new CliApprovalBroker(),
    auditTrail: new AuditTrail(`${config.workspaceRoot}/.swe-agent/audit.jsonl`),
    sandboxProvider,
    skillTokenizer: new TiktokenSkillTokenizer(),
    memoryStore: new MemoryStore(path.join(config.workspaceRoot, ".swe-agent", "memory.sqlite")),
    observability: new Observability(10_000, path.join(config.workspaceRoot, ".swe-agent", "observability.sqlite"), { inputCostPer1k: config.model.inputCostPer1k, outputCostPer1k: config.model.outputCostPer1k }),
    mcpProviders,
    mcpManager,
    pluginLifecycle,
  };
  const scriptAdapter = new SkillScriptAdapter(runSkillScript);
  for (const definition of skillScriptDefinitions(await localSkillProvider.list())) registry.registerDefinition(scriptAdapter.registration(definition));
  const pluginActivation = new PluginActivationManager(pluginLifecycle, skillProviders, mcpProviders, config.hooks ?? [], mcpCredentialStore);
  ctx.pluginActivation = pluginActivation;
  mcpManager.attachPluginActivation(pluginActivation);
  await pluginActivation.refresh(ctx);
  if (config.skills?.watch) skillPlatform.watcher.watch([
    ...(config.skills.repoRoots ?? [configStack.projectRoot]), ...(config.skills.userRoots ?? []),
    ...(config.skills.systemRoots ?? []), ...(config.skills.adminRoots ?? []),
    ...(config.skills.pluginRoots ?? []), ...pluginLifecycle.activeRoots(),
  ]);
  const initialContext = await refreshContextualFragments(ctx);

  if (cli.appServerPort !== undefined) {
    const server = new AppServer(async () => ({ ...ctx, shell: new ShellSession(config.workspaceRoot), workingMemory: {} }), onEvent, ctx.observability, { authToken: process.env.SWE_APP_SERVER_TOKEN });
    const port = await server.listen(cli.appServerPort);
    console.log(`App Server: http://127.0.0.1:${port}`);
    console.log(`SSE: http://127.0.0.1:${port}/events`);
    try { await waitForShutdownSignal(); }
    finally { await server.close(); await shell.close(); await skillPlatform.close(); await pluginActivation.close(); await mcpManager.close(); await mcpElicitationBroker.close(); ctx.memoryStore?.close(); ctx.observability?.close(); }
    return;
  }

  const userRequest = cli.request ?? "列出当前目录内容，然后给出最终结论";

  console.log("=".repeat(60));
  console.log("Minimal SWE Agent");
  console.log(`模型: ${config.useFakeModel ? "FakeModel（演示）" : config.model.model}`);
  console.log(`工作目录: ${config.workspaceRoot}`);
  console.log(`任务: ${userRequest}`);
  if (ctx.contextualFragments?.length) console.log(`上下文片段: 已加载 ${ctx.contextualFragments.length} 项`);
  if (initialContext.diagnostics.length) console.log(`上下文诊断: ${initialContext.diagnostics.length} 项`);
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
    await skillPlatform.close();
    await pluginActivation.close();
    await mcpManager.close();
    await mcpElicitationBroker.close();
    ctx.memoryStore?.close();
    ctx.observability?.close();
  }
}

interface CliArguments { request?: string; resume?: string; fork?: string; atOrdinal?: number; configExplainPath?: string; skillCommand?: string[]; appServerPort?: number }

function parseCliArguments(args: string[]): CliArguments {
  const result: CliArguments = {};
  const requestParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--app-server") {
      const next = args[index + 1];
      if (next && /^\d+$/.test(next)) { result.appServerPort = Number(next); index += 1; } else result.appServerPort = 0;
      continue;
    }
    if (argument === "skills") { result.skillCommand = args.slice(index + 1); break; }
    if (argument === "--config-explain") {
      const value = args[++index];
      if (!value) throw new Error("--config-explain 需要 dotted path");
      result.configExplainPath = value;
      continue;
    }
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
  if (result.configExplainPath && (result.resume || result.fork || requestParts.length > 0)) throw new Error("--config-explain 不能与会话任务参数组合");
  if (result.appServerPort !== undefined && (result.resume || result.fork || requestParts.length > 0 || result.skillCommand)) throw new Error("--app-server 不能与会话任务或 skills 命令组合");
  if (requestParts.length > 0) result.request = requestParts.join(" ");
  return result;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { process.off("SIGINT", done); process.off("SIGTERM", done); resolve(); };
    process.once("SIGINT", done); process.once("SIGTERM", done);
  });
}

async function runSkillsCommand(args: string[], config: AgentContext["config"]): Promise<void> {
  const command = args[0] ?? "list";
  const lifecycle = new PluginLifecycleManager(config.skills?.installRoot ?? path.join(config.workspaceRoot, ".swe-agent", "plugins"));
  await lifecycle.load();
  const audit = new AuditTrail(path.join(config.workspaceRoot, ".swe-agent", "audit.jsonl"));
  const callId = `skills-cli-${Date.now()}`; const source = args.slice(1).join(" ") || "installed plugins";
  const preview = { callId, toolName: `skills.${command}`, summary: `${command}: ${source}`, risk: command === "list" ? "read" as const : command === "search" || command === "install" || command === "upgrade" ? "network" as const : "write" as const, cwd: config.workspaceRoot, affectedPaths: [config.skills?.installRoot ?? path.join(config.workspaceRoot, ".swe-agent", "plugins")], reasons: ["用户显式调用 Skills CLI"] };
  await audit.record({ timestamp: Date.now(), callId, toolName: preview.toolName, phase: "preflight", decision: "allow", preview });
  try {
    let output: unknown;
    if (command === "list") output = lifecycle.list();
    else if (command === "install" && args[1]) output = await lifecycle.install(args[1], undefined, new MarketplaceIndex(), config.skills?.marketplaceIndexes ?? []);
    else if (command === "enable" && args[1]) output = await lifecycle.enable(args[1]);
    else if (command === "disable" && args[1]) output = await lifecycle.disable(args[1]);
    else if (command === "uninstall" && args[1]) output = await lifecycle.uninstall(args[1], args[2]);
    else if (command === "search") output = await new MarketplaceIndex().search(config.skills?.marketplaceIndexes ?? [], args.slice(1).join(" "));
    else if (command === "upgrade" && args[1]) output = await lifecycle.upgrade(args[1], new MarketplaceIndex(), config.skills?.marketplaceIndexes ?? [], args[2] ?? "*");
    else throw new Error(`未知或缺少参数的 skills 命令: ${command}`);
    await audit.record({ timestamp: Date.now(), callId, toolName: preview.toolName, phase: "execution", success: true, preview });
    if (output !== undefined) console.log(JSON.stringify(output, null, 2));
  } catch (error) { await audit.record({ timestamp: Date.now(), callId, toolName: preview.toolName, phase: "execution", success: false, preview, error: error instanceof Error ? error.message : String(error) }); throw error; }
}

function createSandboxProvider(root: string, requestedMode: AgentContext["config"]["sandboxMode"]) {
  if (requestedMode === "best-effort") return new LocalSandboxProvider(root);
  if (requestedMode === "docker") return new WindowsDockerSandboxProvider(root);
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
