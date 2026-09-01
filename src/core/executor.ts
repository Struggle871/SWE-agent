import { randomUUID } from "node:crypto";
import type { AgentAction, AgentContext, ToolResult } from "../types.js";
import type { AgentEvent } from "./events.js";
import type { ApprovalRequest } from "../security/approval-broker.js";
import { ToolPreflight } from "../tools/preflight.js";
import type { AuditRecord } from "../security/audit.js";
import { ToolRouter } from "./tool-router.js";
export { withTimeout } from "./timeout.js";

export interface ExecuteOptions {
  callId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export class Executor {
  private router: ToolRouter;

  constructor(preflight = new ToolPreflight()) {
    this.router = new ToolRouter(preflight);
  }

  async execute(
    action: Extract<AgentAction, { type: "tool_call" }>,
    ctx: AgentContext,
    options: ExecuteOptions = {},
  ): Promise<ToolResult> {
    const callId = options.callId ?? action.callId ?? randomUUID();
    const signal = options.signal ?? new AbortController().signal;
    try {
      return await this.router.route(action, ctx, { ...options, callId, signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.auditTrail.record({
        timestamp: Date.now(), callId, toolName: action.toolName, phase: "execution", success: false, error: message,
      }).catch(() => undefined);
      return errorResult(action.toolName, `工具执行异常: ${message}`);
    }
  }

  private async reject(ctx: AgentContext, callId: string, toolName: string, message: string): Promise<ToolResult> {
    await ctx.auditTrail.record({ timestamp: Date.now(), callId, toolName, phase: "execution", success: false, error: message });
    return errorResult(toolName, message);
  }
}

function errorResult(toolName: string, output: string): ToolResult {
  return { toolName, output, isError: true };
}
