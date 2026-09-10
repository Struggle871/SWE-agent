import { createHash } from "node:crypto";
import type { AgentContext, HookConfig, HookEventName } from "../types.js";
import { createSandboxProfile } from "../security/sandbox.js";

export interface HookDispatchResult {
  blocked: boolean;
  reason?: string;
  additionalContext?: string;
  rewrittenInput?: Record<string, unknown>;
  hookIds: string[];
}

export interface HookLifecycleRecord {
  event: HookEventName;
  hookId: string;
  status: "completed" | "failed" | "blocked" | "skipped";
  durationMs: number;
  reason?: string;
  rewritten: boolean;
  addedContext: boolean;
}

export interface HookEngineOptions {
  maxOutputBytes?: number;
  onLifecycle?: (record: HookLifecycleRecord) => void | Promise<void>;
}

/** Executes configured hooks through the same bounded sandbox used by tools. */
export class HookEngine {
  private hooks: readonly HookConfig[];
  constructor(hooks: readonly HookConfig[] = [], private readonly options: HookEngineOptions = {}) { this.hooks = [...hooks]; }
  replace(hooks: readonly HookConfig[]): void { this.hooks = [...hooks]; }

  async dispatch(event: HookEventName, payload: Record<string, unknown>, ctx: AgentContext, signal?: AbortSignal): Promise<HookDispatchResult> {
    const result: HookDispatchResult = { blocked: false, hookIds: [] };
    for (const hook of this.hooks) {
      if (hook.event !== event || (hook.matcher && !matches(hook.matcher, payload))) continue;
      const startedAt = Date.now();
      result.hookIds.push(hook.id);
      const actualHash = createHash("sha256").update(JSON.stringify({ command: hook.command, args: hook.args ?? [] })).digest("hex");
      if (hook.trustedHash && hook.trustedHash !== actualHash) {
        const message = `Hook ${hook.id} trust hash 不匹配`;
        await this.audit(ctx, hook, event, false, message);
        if ((hook.onError ?? "block") === "block") {
          await this.lifecycle({ event, hookId: hook.id, status: "blocked", durationMs: Date.now() - startedAt, reason: message, rewritten: false, addedContext: false });
          return { ...result, blocked: true, reason: message };
        }
        await this.lifecycle({ event, hookId: hook.id, status: "failed", durationMs: Date.now() - startedAt, reason: message, rewritten: false, addedContext: false });
        continue;
      }
      try {
        const admission = ctx.sandboxProvider?.capabilities();
        if (!admission?.subprocess || !admission.workingDirectory) throw new Error("Hook 缺少 subprocess/workingDirectory sandbox 能力");
        const timeoutMs = hook.timeoutMs ?? ctx.config.toolTimeoutMs;
        const execution = await ctx.sandboxProvider!.execute({
          command: hook.command,
          argv: { executable: hook.command, args: hook.args ?? [] },
          cwd: ctx.workspaceRoot,
          timeoutMs,
          signal,
          env: { SWE_HOOK_EVENT: event, SWE_HOOK_INPUT_JSON: JSON.stringify(payload) },
          profile: createSandboxProfile(ctx.workspaceRoot, timeoutMs, "best_effort"),
          requirements: { filesystem: "workspace", subprocess: true, workingDirectory: true, environment: "filtered", timeout: true, cancellation: true },
        });
        if (execution.timedOut) throw new Error(`Hook 超时 (${timeoutMs}ms)`);
        if (execution.cancelled) throw new Error("Hook 已取消");
        if (execution.exitCode !== 0) throw new Error(execution.stderr || `Hook exit code ${execution.exitCode}`);
        const output = parseHookOutput(execution.stdout, this.options.maxOutputBytes ?? 64 * 1024);
        if (output.additionalContext) result.additionalContext = [result.additionalContext, output.additionalContext].filter(Boolean).join("\n\n");
        if (output.rewrittenInput) result.rewrittenInput = output.rewrittenInput;
        if (output.blocked) {
          const reason = output.reason ?? `Hook ${hook.id} blocked ${event}`;
          await this.lifecycle({ event, hookId: hook.id, status: "blocked", durationMs: Date.now() - startedAt, reason, rewritten: !!output.rewrittenInput, addedContext: !!output.additionalContext });
          return { ...result, blocked: true, reason };
        }
        await this.audit(ctx, hook, event, true);
        await this.lifecycle({ event, hookId: hook.id, status: "completed", durationMs: Date.now() - startedAt, rewritten: !!output.rewrittenInput, addedContext: !!output.additionalContext });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.audit(ctx, hook, event, false, message);
        const timeoutFailure = /超时|取消/.test(message);
        const blocked = (timeoutFailure ? (hook.onTimeout ?? "block") : (hook.onError ?? "block")) === "block";
        await this.lifecycle({ event, hookId: hook.id, status: blocked ? "blocked" : "failed", durationMs: Date.now() - startedAt, reason: message, rewritten: false, addedContext: false });
        if (blocked) return { ...result, blocked: true, reason: message };
      }
    }
    return result;
  }

  private async audit(ctx: AgentContext, hook: HookConfig, event: HookEventName, success: boolean, error?: string): Promise<void> {
    await ctx.auditTrail.record({ timestamp: Date.now(), callId: `hook-${hook.id}-${Date.now()}`, toolName: `hook.${hook.id}`, phase: "execution", success, error, input: { event, hookId: hook.id } }).catch(() => undefined);
  }

  private async lifecycle(record: HookLifecycleRecord): Promise<void> {
    await this.options.onLifecycle?.(record);
  }
}

function matches(pattern: string, payload: Record<string, unknown>): boolean {
  const value = String(payload.toolName ?? payload.command ?? payload.name ?? payload.text ?? "");
  try { return new RegExp(pattern).test(value); } catch { return value === pattern; }
}

function parseHookOutput(raw: string, maxOutputBytes: number): { blocked?: boolean; reason?: string; additionalContext?: string; rewrittenInput?: Record<string, unknown> } {
  if (Buffer.byteLength(raw, "utf8") > maxOutputBytes) throw new Error(`Hook 输出超过 ${maxOutputBytes} bytes`);
  const text = raw.trim();
  if (!text) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hook 输出必须是 JSON 对象");
  const record = value as Record<string, unknown>;
  return {
    ...(record.blocked === true ? { blocked: true } : {}),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record.additionalContext === "string" ? { additionalContext: record.additionalContext } : {}),
    ...(record.rewrittenInput && typeof record.rewrittenInput === "object" && !Array.isArray(record.rewrittenInput) ? { rewrittenInput: record.rewrittenInput as Record<string, unknown> } : {}),
  };
}
