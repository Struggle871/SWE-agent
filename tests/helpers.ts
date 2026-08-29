import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileStateCache } from "../src/core/file-state-cache.js";
import { FakeModelClient } from "../src/model/model-client.js";
import { StaticApprovalBroker, type ApprovalBroker } from "../src/security/approval-broker.js";
import { AuditTrail } from "../src/security/audit.js";
import { DefaultCommandAnalyzer } from "../src/security/command-policy.js";
import { PermissionPolicy } from "../src/security/permission-policy.js";
import { WorkspacePolicy } from "../src/security/workspace-policy.js";
import { editFileTool } from "../src/tools/edit.js";
import { listDirTool, readFileTool, writeFileTool } from "../src/tools/file-io.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { searchContentTool, searchFilesTool } from "../src/tools/search.js";
import { readTerminalOutputTool, runCommandTool, ShellSession } from "../src/tools/terminal.js";
import type { AgentContext } from "../src/types.js";

export async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "minimal-swe-agent-"));
}

export async function makeContext(root: string, approvalBroker: ApprovalBroker = new StaticApprovalBroker(true)): Promise<AgentContext> {
  const registry = new ToolRegistry();
  [runCommandTool, readTerminalOutputTool, readFileTool, writeFileTool, editFileTool, listDirTool, searchFilesTool, searchContentTool]
    .forEach((tool) => registry.register(tool));
  const workspacePolicy = await WorkspacePolicy.create({ readableRoots: [root] });
  return {
    config: {
      maxSteps: 5, maxContextTokens: 8_000, maxOutputTokens: 2_048, toolTimeoutMs: 1_000, parseRetry: 1,
      workspaceRoot: root, model: { baseUrl: "http://unused", model: "fake" }, useFakeModel: true, useLlmPlanning: false,
    },
    registry,
    shell: new ShellSession(root),
    model: new FakeModelClient(process.platform === "win32" ? "dir" : "ls"),
    workspaceRoot: root,
    workingMemory: {},
    fileStateCache: new FileStateCache(),
    workspacePolicy,
    commandAnalyzer: new DefaultCommandAnalyzer(workspacePolicy),
    permissionPolicy: new PermissionPolicy(),
    approvalBroker,
    auditTrail: new AuditTrail(),
  };
}

export async function cleanupContext(ctx: AgentContext): Promise<void> {
  await ctx.shell.close();
  await fs.rm(ctx.workspaceRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}
