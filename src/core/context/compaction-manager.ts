import type { AgentContext, CompletedTaskSummary, Message, Task } from "../../types.js";
import { buildSpecPlan } from "../../tools/spec-plan.js";
import { createCompactionId, createRequestId, type StepId, type TurnId } from "../../protocol/ids.js";
import type {
  ModelEvent, ModelMessage, ModelRequest, ModelToolDefinition, ModelTransport, RemoteCompactionRequest,
} from "../../protocol/model-events.js";
import { modelTransportFor } from "../../model/transport.js";
import type { TranscriptEnvelope, TranscriptKind, TranscriptPayload } from "../../persistence/rollout-schema.js";
import { PromptBuilder } from "../prompt-builder.js";
import {
  envelope, insertInitialContext, normalizeCallPairs, removeOldestItemGroup, retainLocalUserHistory,
} from "./compaction-history.js";
import { resolveCompactionConfig } from "./compaction-config.js";
import type {
  CompactCheckpointPayload, CompactionErrorCode, CompactionHooks, CompactionImplementation,
  CompactionPhase, CompactionReason, CompactionResult, CompactionTrigger, ContextItemEnvelope, TokenStatus,
} from "./compaction-types.js";
import { ContextManager } from "./context-manager.js";
import {
  estimateModelMessageTokens, estimateModelRequestInputTokens, fingerprint, requestFingerprint,
} from "./token-accounting.js";
import { estimateTextTokens } from "./token-estimator.js";
import { buildWorldState, referenceContext, renderWorldState, type WorldStateInput } from "./world-state.js";

const DEFAULT_COMPACTION_PROMPT = [
  "Create a concise but complete handoff checkpoint for another coding agent.",
  "Preserve the user's requirements, decisions, repository state, completed work, failures, and exact next steps.",
  "Do not invent results. Return only the checkpoint text.",
].join("\n");

export interface CompactionRequestContext {
  trigger: CompactionTrigger;
  reason: CompactionReason;
  phase: CompactionPhase;
  signal: AbortSignal;
  turnId?: TurnId;
  stepId?: StepId;
  task?: Task;
  completedTasks?: readonly CompletedTaskSummary[];
  pendingMessages?: readonly Message[];
  prompt?: string;
}

export interface CompactionManagerOptions {
  ctx: AgentContext;
  context: ContextManager;
  persist: (
    kind: TranscriptKind,
    payload: TranscriptPayload,
    context?: { turnId?: TurnId; stepId?: StepId; durable?: boolean },
  ) => Promise<TranscriptEnvelope>;
  hooks?: CompactionHooks;
  onLifecycle?: (status: "started" | "completed" | "failed" | "interrupted", payload: {
    compactionId: string; phase: CompactionPhase; reason: CompactionReason; implementation?: CompactionImplementation; errorCode?: CompactionErrorCode;
  }) => void;
}

export class CompactionFailure extends Error {
  constructor(readonly code: CompactionErrorCode, message: string, readonly committed = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompactionFailure";
  }
}

export class CompactionManager {
  private readonly promptBuilder = new PromptBuilder();

  constructor(private readonly options: CompactionManagerOptions) {}

  private get config() { return resolveCompactionConfig(this.options.ctx.config); }

  tokenStatus(input: { task?: Task; completedTasks?: readonly CompletedTaskSummary[]; pendingMessages?: readonly Message[] }): TokenStatus {
    const pendingMessages = input.pendingMessages ?? [];
    const request = this.projectRequest([
      ...this.options.context.messages(),
      ...pendingMessages.map((message) => structuredClone(message)),
    ], input.task, input.completedTasks);
    const estimated = estimateModelRequestInputTokens(request);
    const anchor = this.options.context.anchoredTokenCount(requestFingerprint(request));
    const pendingTokens = pendingMessages.reduce((sum, message) => sum + estimateModelMessageTokens(message), 0);
    return this.options.context.window.tokenStatus(
      anchor ? anchor.tokens + pendingTokens : estimated,
      this.options.ctx.config,
      anchor ? anchor.estimated || pendingMessages.length > 0 : true,
    );
  }

  async maybeCompact(input: Omit<CompactionRequestContext, "trigger" | "reason"> & { reason?: CompactionReason }): Promise<CompactionResult | undefined> {
    const status = this.tokenStatus(input);
    if (!status.autoCompactLimitReached && !status.hardLimitReached) return undefined;
    return this.compact({ ...input, trigger: "auto", reason: input.reason ?? "context_limit" });
  }

  async compact(input: CompactionRequestContext): Promise<CompactionResult> {
    const compactionId = createCompactionId();
    const currentWindow = this.options.context.window.snapshot();
    if (input.trigger === "auto" && !this.options.context.window.claimAttempt(input.reason, input.phase)) {
      throw new CompactionFailure("compaction_no_progress", "当前窗口已尝试过相同自动压缩，拒绝重复循环");
    }
    const hookEvent = { compactionId, trigger: input.trigger, reason: input.reason, phase: input.phase, window: currentWindow };
    let preHookStopped = false;
    try {
      preHookStopped = await this.options.hooks?.preCompact?.(hookEvent, input.signal) === "stop";
    } catch (error) {
      const failure = new CompactionFailure("compaction_interrupted", `PreCompact hook 失败: ${reasonText(error)}`, false, { cause: error });
      await this.persistLifecycle({ ...hookEvent, status: "interrupted", errorCode: failure.code, message: failure.message }, input).catch(() => undefined);
      throw failure;
    }
    if (preHookStopped) {
      await this.persistLifecycle({ ...hookEvent, status: "interrupted", errorCode: "compaction_interrupted", message: "PreCompact hook stopped compaction" }, input);
      throw new CompactionFailure("compaction_interrupted", "PreCompact hook 已停止压缩");
    }
    throwIfAborted(input.signal);

    const implementation = this.selectImplementation();
    const started = await this.persistLifecycle({ ...hookEvent, implementation, status: "started" }, input);
    this.options.onLifecycle?.("started", { compactionId, phase: input.phase, reason: input.reason, implementation });
    const original = this.options.context.annotatedItems();
    const beforeProjection = this.projectRequest([
      ...original.map((item) => item.message),
      ...(input.pendingMessages ?? []),
    ], input.task, input.completedTasks);
    const activeBefore = estimateModelRequestInputTokens(beforeProjection);
    let backend: BackendResult;
    try {
      backend = await this.runBackend(implementation, original, input);
    } catch (error) {
      const failure = classifyFailure(error, input.signal);
      await this.persistLifecycle({
        ...hookEvent, implementation, status: failure.code === "compaction_interrupted" ? "interrupted" : "failed",
        errorCode: failure.code, message: failure.message,
      }, input).catch(() => undefined);
      this.options.onLifecycle?.(failure.code === "compaction_interrupted" ? "interrupted" : "failed", {
        compactionId, phase: input.phase, reason: input.reason, implementation, errorCode: failure.code,
      });
      throw failure;
    }

    const worldInput: WorldStateInput = {
      ctx: this.options.ctx,
      tools: this.options.ctx.registry.visibleSpecs(),
      ...(input.task ? { task: input.task } : {}),
      ...(input.completedTasks ? { completedTasks: input.completedTasks } : {}),
    };
    const world = buildWorldState(worldInput);
    const initialContext = envelope(
      { role: "system", content: renderWorldState(world) },
      { kind: "context_injection" },
    );
    const replacement = insertInitialContext(normalizeCallPairs(backend.items), initialContext);
    try {
      validateReplacement(replacement, this.config);
    } catch (error) {
      const failure = classifyFailure(error, input.signal);
      await this.persistLifecycle({
        ...hookEvent, implementation, status: failure.code === "compaction_interrupted" ? "interrupted" : "failed",
        errorCode: failure.code, message: failure.message,
      }, input).catch(() => undefined);
      this.options.onLifecycle?.(failure.code === "compaction_interrupted" ? "interrupted" : "failed", {
        compactionId, phase: input.phase, reason: input.reason, implementation, errorCode: failure.code,
      });
      throw failure;
    }
    const afterProjection = this.projectRequest(replacement.map((item) => item.message), input.task, input.completedTasks);
    const activeAfter = estimateModelRequestInputTokens(afterProjection);
    const afterStatus = this.options.context.window.tokenStatus(activeAfter, this.options.ctx.config);
    if (input.trigger === "auto" && original.length > 0 && (activeAfter >= activeBefore || afterStatus.hardLimitReached)) {
      const failure = new CompactionFailure("compaction_no_progress", `压缩后仍未获得安全窗口: ${activeBefore} -> ${activeAfter}`);
      await this.persistLifecycle({ ...hookEvent, implementation, status: "failed", errorCode: failure.code, message: failure.message }, input);
      this.options.onLifecycle?.("failed", { compactionId, phase: input.phase, reason: input.reason, implementation, errorCode: failure.code });
      throw failure;
    }

    const checkpoint: CompactCheckpointPayload = {
      compactionId,
      trigger: input.trigger,
      reason: input.reason,
      phase: input.phase,
      implementation,
      status: "completed",
      ...(backend.summary ? { summary: backend.summary } : {}),
      replacementHistory: replacement,
      window: this.options.context.window.next(),
      tokenUsage: {
        activeBefore,
        activeAfter,
        estimateBefore: activeBefore,
        estimateAfter: activeAfter,
        ...(backend.usage ? { backendUsage: backend.usage, cachedInputTokens: backend.usage.cachedInputTokens } : {}),
      },
      sourceThroughOrdinal: started.ordinal,
      sourceTurnIds: this.options.context.sourceTurnIds(),
      resourceOrigins: { toolResults: "session_artifact_store" },
    };

    let checkpointRecord: TranscriptEnvelope;
    try {
      checkpointRecord = await this.options.persist("compact_checkpoint", checkpoint, compactContext(input, true));
    } catch (error) {
      const failure = new CompactionFailure("compaction_checkpoint_write_failed", "checkpoint durable append 失败，live context 未修改", false, { cause: error });
      await this.persistLifecycle({
        ...hookEvent, implementation, status: "failed", errorCode: failure.code, message: failure.message,
      }, input).catch(() => undefined);
      this.options.onLifecycle?.("failed", { compactionId, phase: input.phase, reason: input.reason, implementation, errorCode: failure.code });
      throw failure;
    }

    this.options.context.installCheckpoint(checkpoint, checkpointRecord.ordinal);
    const compHash = fingerprint({
      model: this.options.ctx.config.model.model,
      instructions: this.options.ctx.contextualFragments?.map((fragment) => fragment.hash).join(":") ?? this.options.ctx.agentMemories ?? "",
      tools: this.options.ctx.registry.visibleSpecs(),
      permissions: this.options.ctx.permissionPolicy.fingerprint(),
    });
    const reference = referenceContext(world, worldInput, compHash);
    try {
      await this.options.persist("world_state", world, compactContext(input, true));
      await this.options.persist("reference_context", reference, compactContext(input, true));
      this.options.context.applyWorldState(world);
      this.options.context.setReference(reference);
    } catch (error) {
      const failure = new CompactionFailure("compaction_baseline_write_failed", "checkpoint 已安装，但 baseline append 失败；恢复时将全量重注入", true, { cause: error });
      await this.persistLifecycle({
        ...hookEvent, implementation, status: "failed", errorCode: failure.code, message: failure.message,
      }, input).catch(() => undefined);
      this.options.onLifecycle?.("failed", { compactionId, phase: input.phase, reason: input.reason, implementation, errorCode: failure.code });
      throw failure;
    }

    this.options.onLifecycle?.("completed", { compactionId, phase: input.phase, reason: input.reason, implementation });
    let postHookStopped = false;
    try {
      postHookStopped = await this.options.hooks?.postCompact?.({ ...hookEvent, implementation }, input.signal) === "stop";
    } catch (error) {
      const failure = new CompactionFailure("compaction_post_hook_stopped", `PostCompact hook 失败: ${reasonText(error)}`, true, { cause: error });
      await this.persistLifecycle({
        ...hookEvent, implementation, status: "failed", errorCode: failure.code, message: failure.message,
      }, input).catch(() => undefined);
      throw failure;
    }
    if (postHookStopped) {
      try {
        await this.persistLifecycle({
          ...hookEvent,
          implementation,
          status: "failed",
          errorCode: "compaction_post_hook_stopped",
          message: "PostCompact hook stopped later turn work after checkpoint commit",
        }, input);
      } catch (error) {
        throw new CompactionFailure("compaction_baseline_write_failed", "checkpoint 已安装，但 PostCompact lifecycle append 失败", true, { cause: error });
      }
      this.options.onLifecycle?.("failed", {
        compactionId, phase: input.phase, reason: input.reason, implementation, errorCode: "compaction_post_hook_stopped",
      });
    }
    return { compactionId, checkpoint, postHookStopped };
  }

  private async runBackend(
    implementation: CompactionImplementation,
    original: readonly ContextItemEnvelope[],
    input: CompactionRequestContext,
  ): Promise<BackendResult> {
    if (implementation === "new_context_window") {
      return { items: retainLocalUserHistory(original, this.config.maxRetainedUserTokens) };
    }
    if (implementation === "remote_compact" || implementation === "remote_compaction_v2") {
      return this.runRemote(implementation, original, input);
    }
    return this.runLocal(original, input);
  }

  private async runLocal(original: readonly ContextItemEnvelope[], input: CompactionRequestContext): Promise<BackendResult> {
    const transport = modelTransportFor(this.options.ctx.model);
    let compactInput = normalizeCallPairs(original.filter((item) => item.metadata.kind !== "context_injection"));
    const instruction = boundedPrompt(input.prompt ?? this.config.prompt ?? DEFAULT_COMPACTION_PROMPT, this.config.maxItemBytes);
    const tools: ModelToolDefinition[] = [];
    while (true) {
      const request: ModelRequest = {
        requestId: createRequestId(),
        messages: [
          ...compactInput.map((item) => toModelMessage(item.message)),
          { role: "user", content: instruction },
        ],
        tools,
        temperature: 0,
        maxOutputTokens: this.options.ctx.config.maxOutputTokens,
      };
      const estimate = estimateModelRequestInputTokens({
        ...request, model: this.options.ctx.config.model.model, maxOutputTokens: request.maxOutputTokens ?? this.options.ctx.config.maxOutputTokens,
      });
      if (estimate + this.options.ctx.config.maxOutputTokens + this.config.fallbackBufferTokens <= this.options.ctx.config.maxContextTokens) {
        let generated: Awaited<ReturnType<typeof collectText>>;
        try {
          generated = await retry(
            () => collectText(transport, request, input.signal, this.config.timeoutMs),
            this.config.maxRetries,
            input.signal,
          );
        } catch (error) {
          if (error instanceof CompactionFailure && error.code === "compaction_context_overflow") {
            const trimmed = removeOldestItemGroup(compactInput);
            if (trimmed.length < compactInput.length) { compactInput = trimmed; continue; }
          }
          throw error;
        }
        const summary = generated.text.trim();
        if (!summary) throw new CompactionFailure("compaction_backend_failed", "local compaction 返回空摘要");
        const retained = retainLocalUserHistory(original, this.config.maxRetainedUserTokens);
        retained.push(envelope({ role: "user", content: `<context_checkpoint>\n${summary}\n</context_checkpoint>` }, { kind: "compaction_summary" }));
        return { items: retained, summary, ...(generated.usage ? { usage: generated.usage } : {}) };
      }
      const trimmed = removeOldestItemGroup(compactInput);
      if (trimmed.length === compactInput.length || compactInput.length === 0) {
        throw new CompactionFailure("compaction_context_overflow", "compaction 请求自身无法放入模型上下文");
      }
      compactInput = trimmed;
    }
  }

  private async runRemote(
    implementation: "remote_compact" | "remote_compaction_v2",
    original: readonly ContextItemEnvelope[],
    input: CompactionRequestContext,
  ): Promise<BackendResult> {
    const transport = modelTransportFor(this.options.ctx.model);
    if (!transport.compact) throw new CompactionFailure("compaction_backend_failed", "模型 transport 未实现 remote compaction");
    const instruction = boundedPrompt(input.prompt ?? this.config.prompt ?? DEFAULT_COMPACTION_PROMPT, this.config.maxItemBytes);
    let compactInput = normalizeCallPairs(original.filter((item) => item.metadata.kind !== "context_injection"));
    const tools = modelTools(this.options.ctx);
    while (true) {
      const request: RemoteCompactionRequest = {
        requestId: createRequestId(),
        implementation,
        model: this.options.ctx.config.model.model,
        input: compactInput.map((item) => toModelMessage(item.message)),
        instructions: instruction,
        tools,
        parallelToolCalls: false,
        maxOutputTokens: this.options.ctx.config.maxOutputTokens,
      };
      const estimate = estimateModelRequestInputTokens({
        messages: request.input, tools, model: request.model, maxOutputTokens: request.maxOutputTokens,
      }) + estimateTextTokens(request.instructions);
      if (estimate + request.maxOutputTokens + this.config.fallbackBufferTokens <= this.options.ctx.config.maxContextTokens) {
        let result: Awaited<ReturnType<NonNullable<ModelTransport["compact"]>>>;
        try {
          result = await retry(
            () => withTimeout((signal) => transport.compact!(request, signal), input.signal, this.config.timeoutMs),
            this.config.maxRetries,
            input.signal,
          );
        } catch (error) {
          if (error instanceof CompactionFailure && error.code === "compaction_context_overflow") {
            const trimmed = removeOldestItemGroup(compactInput);
            if (trimmed.length < compactInput.length) { compactInput = trimmed; continue; }
          }
          throw error;
        }
        if (result.metadata && result.metadata.length !== result.replacement.length) {
          throw new CompactionFailure("compaction_invalid_replacement", "remote replacement metadata 数量不匹配");
        }
        const items = result.replacement
          .map((message, index) => ({ message, metadata: result.metadata?.[index] }))
          .filter(({ message }) => message.role !== "system")
          .map(({ message, metadata }) => envelope(fromModelMessage(message), {
            kind: "remote_compaction",
            ...(metadata ? { provider: metadata } : {}),
          }));
        return { items, ...(result.usage ? { usage: result.usage } : {}) };
      }
      const trimmed = removeOldestItemGroup(compactInput);
      if (trimmed.length === compactInput.length || compactInput.length === 0) {
        throw new CompactionFailure("compaction_context_overflow", "remote compaction 请求自身无法放入模型上下文");
      }
      compactInput = trimmed;
    }
  }

  private selectImplementation(): CompactionImplementation {
    const preference = this.config.backend;
    const capabilities = modelTransportFor(this.options.ctx.model).capabilities();
    if (preference === "local") return "local_responses";
    if (preference === "remote") return "remote_compact";
    if (preference === "remote_v2") return "remote_compaction_v2";
    if (preference === "new_context") return "new_context_window";
    if (capabilities.remoteCompaction === "v2") return "remote_compaction_v2";
    if (capabilities.remoteCompaction === "v1") return "remote_compact";
    return "local_responses";
  }

  private projectRequest(messages: readonly Message[], task?: Task, completedTasks?: readonly CompletedTaskSummary[]) {
    const built = this.promptBuilder.build({
      messages,
      ...(task ? { currentTask: task } : {}),
      ...(completedTasks ? { completedTasks: [...completedTasks] } : {}),
      workingMemory: this.options.ctx.workingMemory,
      tools: this.options.ctx.registry.visibleSpecs(),
      config: this.options.ctx.config,
      agentMemories: this.options.ctx.agentMemories,
    });
    return {
      messages: built.map(toModelMessage),
      tools: modelTools(this.options.ctx),
      maxOutputTokens: this.options.ctx.config.maxOutputTokens,
      model: this.options.ctx.config.model.model,
    };
  }

  private persistLifecycle(
    payload: TranscriptPayload & { status: "started" | "failed" | "interrupted" },
    input: CompactionRequestContext,
  ): Promise<TranscriptEnvelope> {
    return this.options.persist("compaction_lifecycle", payload, compactContext(input));
  }
}

interface BackendResult { items: ContextItemEnvelope[]; summary?: string; usage?: import("../../protocol/usage.js").Usage }

function compactContext(input: CompactionRequestContext, durable = false) {
  return {
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(durable ? { durable: true } : {}),
  };
}

function modelTools(ctx: AgentContext): ModelToolDefinition[] {
  return [...buildSpecPlan(ctx.registry).definitions];
}

function toModelMessage(message: Message): ModelMessage {
  return {
    role: message.role, content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  };
}

function fromModelMessage(message: ModelMessage): Message {
  return {
    role: message.role, content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    ...(message.toolCalls ? { toolCalls: [...message.toolCalls] } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
  };
}

function validateReplacement(items: readonly ContextItemEnvelope[], config: ReturnType<typeof resolveCompactionConfig>): void {
  if (items.length > config.maxCheckpointItems) throw new CompactionFailure("compaction_invalid_replacement", "replacement history item 数超限");
  const ids = new Set<string>();
  let total = 0;
  for (const item of items) {
    if (!item.id || ids.has(item.id)) throw new CompactionFailure("compaction_invalid_replacement", "replacement history item id 缺失或重复");
    ids.add(item.id);
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes > config.maxItemBytes) throw new CompactionFailure("compaction_invalid_replacement", "replacement history 单 item 超限");
    total += bytes;
  }
  if (total > config.maxCheckpointBytes) throw new CompactionFailure("compaction_invalid_replacement", "replacement history 总大小超限");
  const normalized = normalizeCallPairs(items);
  if (normalized.length !== items.length) throw new CompactionFailure("compaction_invalid_replacement", "replacement history 存在未配对 tool call/output");
}

async function collectText(
  transport: ModelTransport,
  request: ModelRequest,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<{ text: string; usage?: import("../../protocol/usage.js").Usage }> {
  return withTimeout(async (signal) => {
    let text = "";
    let usage: import("../../protocol/usage.js").Usage | undefined;
    for await (const event of transport.stream(request, signal)) {
      consumeEvent(event);
      if (event.type === "text_delta") text += event.text;
      if (event.type === "usage") usage = event.usage;
    }
    return { text, ...(usage ? { usage } : {}) };
  }, parentSignal, timeoutMs);
}

function consumeEvent(_event: ModelEvent): void {}

async function retry<T>(operation: () => Promise<T>, maxRetries: number, signal: AbortSignal): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    throwIfAborted(signal);
    try { return await operation(); } catch (error) {
      last = error;
      if (isContextOverflow(error)) throw new CompactionFailure("compaction_context_overflow", reasonText(error), false, { cause: error });
      if (signal.aborted || error instanceof CompactionFailure && [
        "compaction_interrupted", "compaction_context_overflow", "compaction_invalid_replacement",
      ].includes(error.code)) throw error;
      if (attempt < maxRetries) await abortableDelay(Math.min(1_000, 50 * 2 ** attempt), signal);
    }
  }
  throw last;
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason ?? new Error("compaction interrupted"));
  if (parent.aborted) onAbort(); else parent.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new CompactionFailure("compaction_timeout", `compaction 超过 ${timeoutMs}ms`)), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    parent.removeEventListener("abort", onAbort);
  }
}

function classifyFailure(error: unknown, signal: AbortSignal): CompactionFailure {
  if (error instanceof CompactionFailure) return error;
  if (signal.aborted) return new CompactionFailure("compaction_interrupted", reasonText(signal.reason), false, { cause: error });
  return new CompactionFailure("compaction_backend_failed", reasonText(error), false, { cause: error });
}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CompactionFailure("compaction_interrupted", reasonText(signal.reason));
}
function reasonText(value: unknown): string { return value instanceof Error ? value.message : value ? String(value) : "compaction interrupted"; }
function isContextOverflow(value: unknown): boolean {
  if (value instanceof CompactionFailure) return value.code === "compaction_context_overflow";
  return /context.{0,20}(length|limit|overflow)|too many tokens/i.test(reasonText(value));
}
function boundedPrompt(prompt: string, maxBytes: number): string {
  if (Buffer.byteLength(prompt, "utf8") > maxBytes) throw new CompactionFailure("compaction_invalid_replacement", "custom compaction prompt 超限");
  return prompt;
}
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("compaction interrupted")); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
