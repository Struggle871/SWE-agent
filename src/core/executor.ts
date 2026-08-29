import { randomUUID } from "node:crypto";
import type { AgentAction, AgentContext, ToolResult } from "../types.js";
import type { AgentEvent } from "./events.js";
import type { ApprovalRequest } from "../security/approval-broker.js";
import { ToolPreflight } from "../tools/preflight.js";
import type { AuditRecord } from "../security/audit.js";

export interface ExecuteOptions {
  callId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export class Executor {
  constructor(private preflight = new ToolPreflight()) {}

  async execute(
    action: Extract<AgentAction, { type: "tool_call" }>,
    ctx: AgentContext,
    options: ExecuteOptions = {},
  ): Promise<ToolResult> {
    const tool = ctx.registry.get(action.toolName);
    if (!tool) return errorResult(action.toolName, `未知工具: ${action.toolName}`);

    const callId = options.callId ?? randomUUID();
    const signal = options.signal ?? new AbortController().signal;
    let failurePhase: AuditRecord["phase"] = "preflight";
    try {
      let checked = await this.preflight.run(callId, tool, action.toolInput, ctx);
      options.onEvent?.({ type: "tool_preview", preview: checked.preview });
      await ctx.auditTrail.record({
        timestamp: Date.now(), callId, toolName: tool.name, phase: "preflight",
        decision: checked.decision, preview: checked.preview, input: checked.normalizedInput,
        beforeHashes: checked.fileHashes,
      });

      if (checked.decision === "deny") {
        return await this.reject(ctx, callId, tool.name, `安全策略拒绝执行: ${checked.preview.reasons.join("；")}`);
      }

      if (checked.decision === "ask") {
        failurePhase = "approval";
        const request: ApprovalRequest = {
          requestId: randomUUID(), preview: checked.preview, permissionFingerprint: checked.permissionFingerprint,
        };
        options.onEvent?.({ type: "approval_requested", request });
        const approval = await ctx.approvalBroker.request(request, signal);
        options.onEvent?.({ type: "approval_resolved", result: approval });
        await ctx.auditTrail.record({
          timestamp: Date.now(), callId, toolName: tool.name, phase: "approval", approval,
        });
        if (!approval.approved) return await this.reject(ctx, callId, tool.name, "用户或权限策略拒绝执行工具");

        failurePhase = "revalidation";
        const revalidated = await this.preflight.run(callId, tool, action.toolInput, ctx);
        const unchanged = revalidated.permissionFingerprint === checked.permissionFingerprint;
        await ctx.auditTrail.record({
          timestamp: Date.now(), callId, toolName: tool.name, phase: "revalidation",
          decision: revalidated.decision, preview: revalidated.preview,
          success: unchanged, beforeHashes: revalidated.fileHashes,
          error: unchanged ? undefined : "审批后目标、内容或权限发生变化",
        });
        if (!unchanged) {
          options.onEvent?.({ type: "tool_preview", preview: revalidated.preview });
          return await this.reject(ctx, callId, tool.name, "审批后目标、文件内容或权限发生变化；旧审批已失效，请重新发起工具调用");
        }
        if (revalidated.decision === "deny") return await this.reject(ctx, callId, tool.name, "复检时安全策略拒绝执行");
        checked = revalidated;
      }

      if (signal.aborted) return await this.reject(ctx, callId, tool.name, "工具执行已取消");
      failurePhase = "execution";
      const result = await withTimeout(tool.execute(checked.normalizedInput, ctx), ctx.config.toolTimeoutMs);
      const afterHashes = await collectHashes(Object.keys(checked.fileHashes), ctx);
      await ctx.auditTrail.record({
        timestamp: Date.now(), callId, toolName: tool.name, phase: "execution",
        success: result.isError !== true, error: result.isError ? result.output : undefined,
        beforeHashes: checked.fileHashes, afterHashes,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.auditTrail.record({
        timestamp: Date.now(), callId, toolName: action.toolName, phase: failurePhase, success: false, error: message,
      }).catch(() => undefined);
      return errorResult(action.toolName, `工具执行异常: ${message}`);
    }
  }

  private async reject(ctx: AgentContext, callId: string, toolName: string, message: string): Promise<ToolResult> {
    await ctx.auditTrail.record({ timestamp: Date.now(), callId, toolName, phase: "execution", success: false, error: message });
    return errorResult(toolName, message);
  }
}

async function collectHashes(paths: string[], ctx: AgentContext): Promise<Record<string, string | null>> {
  const hashes: Record<string, string | null> = {};
  for (const file of paths) hashes[file] = (await ctx.fileStateCache.currentSnapshot(file))?.contentHash ?? null;
  return hashes;
}

function errorResult(toolName: string, output: string): ToolResult {
  return { toolName, output, isError: true };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`操作超时（${ms}ms）`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
