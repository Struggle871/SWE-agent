import { randomUUID } from "node:crypto";
import type { AgentAction, AgentContext, ToolResult } from "../types.js";
import type { ApprovalRequest } from "../security/approval-broker.js";
import type { AuditRecord } from "../security/audit.js";
import { SandboxCapabilityError, missingSandboxCapabilities } from "../security/sandbox.js";
import type { ToolPreflightResult } from "../tools/preview.js";
import { qualifiedName } from "../tools/registry.js";
import { ToolPreflight } from "../tools/preflight.js";
import type { AgentEvent } from "./events.js";
import { withAbortTimeout } from "./timeout.js";

export interface RouteOptions {
  callId: string;
  signal: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export class ToolRouter {
  constructor(private readonly preflight = new ToolPreflight()) {}

  async route(action: Extract<AgentAction, { type: "tool_call" }>, ctx: AgentContext, options: RouteOptions): Promise<ToolResult> {
    const registration = ctx.registry.getRegistration(action.toolName);
    if (!registration || (registration.spec.exposure ?? "direct") !== "direct") return errorResult(action.toolName, `未知或不可用工具: ${action.toolName}`);
    const spec = registration.spec;
    const toolName = qualifiedName(spec);
    const runtime = registration.runtime;
    let failurePhase: AuditRecord["phase"] = "preflight";
    try {
      let checked = await this.preflight.run(options.callId, spec, action.toolInput, ctx);
      options.onEvent?.({ type: "tool_preview", preview: checked.preview });
      await ctx.auditTrail.record({ timestamp: Date.now(), callId: options.callId, toolName, phase: "preflight", decision: checked.decision, preview: checked.preview, input: checked.normalizedInput, beforeHashes: checked.fileHashes });
      if (checked.decision === "deny") return this.reject(ctx, options.callId, toolName, `安全策略拒绝执行: ${checked.preview.reasons.join("；")}`);
      if (checked.decision === "ask") {
        failurePhase = "approval";
        const request: ApprovalRequest = { requestId: randomUUID(), preview: checked.preview, permissionFingerprint: checked.permissionFingerprint };
        options.onEvent?.({ type: "approval_requested", request });
        const approval = await ctx.approvalBroker.request(request, options.signal);
        options.onEvent?.({ type: "approval_resolved", result: approval });
        await ctx.auditTrail.record({ timestamp: Date.now(), callId: options.callId, toolName, phase: "approval", approval });
        if (!approval.approved) return this.reject(ctx, options.callId, toolName, "用户或权限策略拒绝执行工具");
        failurePhase = "revalidation";
        const revalidated = await this.preflight.run(options.callId, spec, action.toolInput, ctx);
        const unchanged = revalidated.permissionFingerprint === checked.permissionFingerprint;
        await ctx.auditTrail.record({ timestamp: Date.now(), callId: options.callId, toolName, phase: "revalidation", decision: revalidated.decision, preview: revalidated.preview, success: unchanged, beforeHashes: revalidated.fileHashes, error: unchanged ? undefined : "审批后目标、内容或权限发生变化" });
        if (!unchanged) { options.onEvent?.({ type: "tool_preview", preview: revalidated.preview }); return this.reject(ctx, options.callId, toolName, "审批后目标、文件内容或权限发生变化；旧审批已失效，请重新发起工具调用"); }
        if (revalidated.decision === "deny") return this.reject(ctx, options.callId, toolName, "复检时安全策略拒绝执行");
        checked = revalidated;
      }
      if (options.signal.aborted) return this.reject(ctx, options.callId, toolName, "工具执行已取消");
      await this.assertSandbox(checked, ctx, options.callId);
      failurePhase = "execution";
      const result = await withAbortTimeout(
        (signal) => runtime.execute(checked.normalizedInput, ctx, { signal }),
        ctx.config.toolTimeoutMs,
        options.signal,
      );
      const afterHashes = await collectHashes(Object.keys(checked.fileHashes), ctx);
      await ctx.auditTrail.record({ timestamp: Date.now(), callId: options.callId, toolName, phase: "execution", success: result.isError !== true, error: result.isError ? result.output : undefined, beforeHashes: checked.fileHashes, afterHashes });
      return normalizeResult(result, toolName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.auditTrail.record({ timestamp: Date.now(), callId: options.callId, toolName, phase: failurePhase, success: false, error: message }).catch(() => undefined);
      return errorResult(toolName, `工具执行异常: ${message}`);
    }
  }

  private async assertSandbox(checked: ToolPreflightResult, ctx: AgentContext, callId: string): Promise<void> {
    if (checked.preview.toolName !== "run_command") return;
    const assessment = await ctx.commandAnalyzer.analyze(String(checked.normalizedInput.command ?? ""), ctx.workspaceRoot);
    const provider = ctx.sandboxProvider;
    const requirements = assessment.requires;
    if (!provider) throw new SandboxCapabilityError(["sandbox provider"]);
    if (!provider.capabilities().osEnforced && assessment.reasons.some((reason) => /动态|无法静态|命令替换|glob|变量/.test(reason))) {
      throw new SandboxCapabilityError(["OS-enforced boundary for dynamic command"]);
    }
    const missing = missingSandboxCapabilities(provider.capabilities(), requirements);
    if (missing.length > 0) {
      await ctx.auditTrail.record({ timestamp: Date.now(), callId, toolName: checked.preview.toolName, phase: "execution", success: false, error: `sandbox capability missing: ${missing.join(", ")}` });
      throw new SandboxCapabilityError(missing);
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

function normalizeResult(result: ToolResult, toolName: string): ToolResult {
  return { toolName, output: String(result.output ?? ""), isError: result.isError, metadata: result.metadata };
}

function errorResult(toolName: string, output: string): ToolResult { return { toolName, output, isError: true }; }
