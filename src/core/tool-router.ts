import { randomUUID } from "node:crypto";
import type { AgentAction, AgentContext, ToolResult } from "../types.js";
import type { ApprovalRequest } from "../security/approval-broker.js";
import type { AuditRecord, SandboxAudit } from "../security/audit.js";
import { createSandboxProfile, SandboxCapabilityError, SandboxManager, sandboxProfileFingerprint, type SandboxAdmission } from "../security/sandbox.js";
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
  constructor(
    private readonly preflight = new ToolPreflight(),
    private readonly sandboxManagerFactory = (provider: NonNullable<AgentContext["sandboxProvider"]>) => new SandboxManager(provider),
  ) {}

  async route(action: Extract<AgentAction, { type: "tool_call" }>, ctx: AgentContext, options: RouteOptions): Promise<ToolResult> {
    const preHook = await ctx.hooks?.dispatch("PreToolUse", { toolName: action.toolName, input: action.toolInput }, ctx, options.signal);
    if (preHook?.blocked) return errorResult(action.toolName, preHook.reason ?? "PreToolUse hook blocked tool");
    const routedAction = preHook?.rewrittenInput ? { ...action, toolInput: preHook.rewrittenInput } : action;
    const lease = ctx.registry.acquireRegistration(routedAction.toolName);
    const registration = lease?.registration;
    if (!registration || (registration.spec.exposure ?? "direct") !== "direct") { lease?.release(); return errorResult(routedAction.toolName, `未知或不可用工具: ${routedAction.toolName}`); }
    const spec = registration.spec;
    const toolName = qualifiedName(spec);
    const runtime = registration.runtime;
    let failurePhase: AuditRecord["phase"] = "preflight";
    try {
      let checked = await this.preflight.run(options.callId, spec, routedAction.toolInput, ctx);
      options.onEvent?.({ type: "tool_preview", preview: checked.preview });
      await ctx.auditTrail.record({ timestamp: Date.now(), callId: options.callId, toolName, phase: "preflight", decision: checked.decision, preview: checked.preview, input: checked.normalizedInput, beforeHashes: checked.fileHashes });
      if (checked.decision === "deny") return this.reject(ctx, options.callId, toolName, `安全策略拒绝执行: ${checked.preview.reasons.join("；")}`);
      if (checked.decision === "ask") {
        failurePhase = "approval";
        const request: ApprovalRequest = { requestId: randomUUID(), preview: checked.preview, permissionFingerprint: checked.permissionFingerprint };
        options.onEvent?.({ type: "approval_requested", request });
        const permissionHook = await ctx.hooks?.dispatch("PermissionRequest", { requestId: request.requestId, toolName, risk: checked.preview.risk, preview: checked.preview }, ctx, options.signal);
        if (permissionHook?.blocked) return this.reject(ctx, options.callId, toolName, permissionHook.reason ?? "PermissionRequest hook blocked approval");
        const approval = await ctx.approvalBroker.request(request, options.signal);
        options.onEvent?.({ type: "approval_resolved", result: approval });
        await ctx.auditTrail.record({ timestamp: Date.now(), callId: options.callId, toolName, phase: "approval", approval });
        if (!approval.approved) return this.reject(ctx, options.callId, toolName, "用户或权限策略拒绝执行工具");
        failurePhase = "revalidation";
        const revalidated = await this.preflight.run(options.callId, spec, routedAction.toolInput, ctx);
        const unchanged = revalidated.permissionFingerprint === checked.permissionFingerprint;
        await ctx.auditTrail.record({ timestamp: Date.now(), callId: options.callId, toolName, phase: "revalidation", decision: revalidated.decision, preview: revalidated.preview, success: unchanged, beforeHashes: revalidated.fileHashes, error: unchanged ? undefined : "审批后目标、内容或权限发生变化" });
        if (!unchanged) { options.onEvent?.({ type: "tool_preview", preview: revalidated.preview }); return this.reject(ctx, options.callId, toolName, "审批后目标、文件内容或权限发生变化；旧审批已失效，请重新发起工具调用"); }
        if (revalidated.decision === "deny") return this.reject(ctx, options.callId, toolName, "复检时安全策略拒绝执行");
        checked = revalidated;
      }
      if (options.signal.aborted) return this.reject(ctx, options.callId, toolName, "工具执行已取消");
      const sandboxAdmission = await this.assertSandbox(checked, spec, ctx, options.callId);
      failurePhase = "execution";
      const result = await withAbortTimeout(
        (signal) => runtime.execute(checked.normalizedInput, ctx, { signal }),
        ctx.config.toolTimeoutMs,
        options.signal,
      );
      const afterHashes = await collectHashes(Object.keys(checked.fileHashes), ctx);
      await ctx.auditTrail.record({ timestamp: Date.now(), callId: options.callId, toolName, phase: "execution", success: result.isError !== true, error: result.isError ? result.output : undefined, beforeHashes: checked.fileHashes, afterHashes, sandbox: sandboxAdmission ? describeSandbox(sandboxAdmission) : undefined });
      let normalized = normalizeResult(result, toolName);
      const postHook = await ctx.hooks?.dispatch("PostToolUse", { toolName, input: routedAction.toolInput, output: normalized.output, isError: normalized.isError === true }, ctx, options.signal);
      if (postHook?.blocked) return errorResult(toolName, postHook.reason ?? "PostToolUse hook blocked tool result");
      const hookContext = [preHook?.additionalContext, postHook?.additionalContext].filter((value): value is string => !!value);
      if (hookContext.length > 0) normalized = { ...normalized, output: `${normalized.output}\n\n[hook context]\n${hookContext.join("\n\n")}` };
      return normalized;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.auditTrail.record({ timestamp: Date.now(), callId: options.callId, toolName, phase: failurePhase, success: false, error: message }).catch(() => undefined);
      return errorResult(toolName, `工具执行异常: ${message}`);
    } finally {
      lease.release();
    }
  }

  private async assertSandbox(checked: ToolPreflightResult, spec: import("../tools/types.js").ToolSpec, ctx: AgentContext, callId: string): Promise<SandboxAdmission | undefined> {
    if (!spec.sandbox && checked.preview.toolName !== "run_command") return undefined;
    const command = checked.preview.command ?? String(checked.normalizedInput.command ?? "");
    const assessment = command ? await ctx.commandAnalyzer.analyze(command, ctx.workspaceRoot) : undefined;
    const provider = ctx.sandboxProvider;
    const requirements = spec.sandbox ?? assessment?.requires;
    if (!provider) throw new SandboxCapabilityError(["sandbox provider"]);
    const capabilities = provider.capabilities();
    const strictness = capabilities.enforcement === "container" ? "required" : "best_effort";
    try {
      const profile = createSandboxProfile(ctx.workspaceRoot, ctx.config.toolTimeoutMs, strictness);
      const admission = this.sandboxManagerFactory(provider).admit(
        profile,
        requirements,
      );
      if (!capabilities.osEnforced && assessment?.reasons.some((reason) => /动态|无法静态|命令替换|glob|变量/.test(reason))) {
        throw new SandboxCapabilityError(["OS-enforced boundary for dynamic command"]);
      }
      return admission;
    } catch (error) {
      const missing = error instanceof SandboxCapabilityError ? error.missing : [String(error)];
      await ctx.auditTrail.record({ timestamp: Date.now(), callId, toolName: checked.preview.toolName, phase: "execution", success: false, error: `sandbox capability missing: ${missing.join(", ")}` });
      throw error;
    }
  }

  private async reject(ctx: AgentContext, callId: string, toolName: string, message: string): Promise<ToolResult> {
    await ctx.auditTrail.record({ timestamp: Date.now(), callId, toolName, phase: "execution", success: false, error: message });
    return errorResult(toolName, message);
  }
}

function describeSandbox(admission: SandboxAdmission): SandboxAudit {
  const { profile, capabilities } = admission;
  const requestedEnforcement = profile.strictness === "required" ? "os" : "best_effort";
  return {
    provider: capabilities.platform,
    profileFingerprint: sandboxProfileFingerprint(profile),
    requestedEnforcement,
    actualEnforcement: capabilities.enforcement,
    requestedNetwork: profile.network.mode,
    actualNetwork: capabilities.network,
    requestedReadRoots: profile.readRoots,
    requestedWriteRoots: profile.writeRoots,
    filesystemEnforced: capabilities.filesystemEnforced,
    networkEnforced: capabilities.networkEnforced,
    processTreeTracked: capabilities.processTreeTracked,
    degraded: requestedEnforcement !== capabilities.enforcement && profile.strictness !== "best_effort",
  };
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
