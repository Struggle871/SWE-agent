import type { Tool } from "./types.js";

export const spawnAgentTool: Tool = {
  name: "spawn_agent", description: "启动一个本地子 Agent 执行独立任务，返回可追踪的 agent id。", isReadOnly: false,
  parameters: { type: "object", properties: { prompt: { type: "string" }, taskName: { type: "string" }, taskId: { type: "string" }, isolateWorkspace: { type: "boolean" }, forkMode: { type: "string" } }, required: ["prompt"], additionalProperties: false },
  async execute(input, ctx) {
    if (!ctx.agentManager) return { toolName: "spawn_agent", output: "Agent manager 未启用", isError: true };
    try {
      const forkMode = input.forkMode === "all" || input.forkMode === "none" || typeof input.forkMode === "number" ? input.forkMode : "none";
      const taskId = typeof input.taskId === "string" ? input.taskId : typeof input.taskName === "string" && ctx.taskGraph ? ctx.taskGraph.create({ description: input.taskName }).id : undefined;
      return { toolName: "spawn_agent", output: JSON.stringify(await ctx.agentManager.spawn(String(input.prompt), ctx.sessionId, { isolateWorkspace: input.isolateWorkspace === true, forkMode, ...(taskId ? { taskId } : {}) })) };
    }
    catch (error) { return { toolName: "spawn_agent", output: errorText(error), isError: true }; }
  },
};

export const listAgentsTool: Tool = {
  name: "list_agents", description: "列出当前会话已启动的子 Agent 状态。", isReadOnly: true,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) { return { toolName: "list_agents", output: JSON.stringify(ctx.agentManager?.list() ?? []) }; },
};

export const waitAgentTool: Tool = {
  name: "wait_agent", description: "等待子 Agent 完成并取得结构化结果摘要。", isReadOnly: false,
  parameters: { type: "object", properties: { agentId: { type: "string" }, timeoutMs: { type: "number" } }, required: ["agentId"], additionalProperties: false },
  async execute(input, ctx) {
    if (!ctx.agentManager) return { toolName: "wait_agent", output: "Agent manager 未启用", isError: true };
    try { return { toolName: "wait_agent", output: JSON.stringify(await ctx.agentManager.wait(String(input.agentId), typeof input.timeoutMs === "number" ? input.timeoutMs : undefined)) }; }
    catch (error) { return { toolName: "wait_agent", output: errorText(error), isError: true }; }
  },
};

export const sendMessageTool: Tool = {
  name: "send_message", description: "通过持久 mailbox 向子 Agent 发送消息。", isReadOnly: false,
  parameters: { type: "object", properties: { agentId: { type: "string" }, message: { type: "string" } }, required: ["agentId", "message"], additionalProperties: false },
  async execute(input, ctx) {
    if (!ctx.agentManager) return { toolName: "send_message", output: "Agent manager 未启用", isError: true };
    try { return { toolName: "send_message", output: JSON.stringify(await ctx.agentManager.send(String(input.agentId), String(input.message))) }; }
    catch (error) { return { toolName: "send_message", output: errorText(error), isError: true }; }
  },
};

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
