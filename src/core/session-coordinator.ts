import path from "node:path";
import type { AgentContext, AgentRunResult, Message, ToolResult } from "../types.js";
import { createSessionId, createTurnId, type CallId, type SessionId, type StepId, type TurnId } from "../protocol/ids.js";
import type { AgentEvent, SessionState } from "./events.js";
import { InputQueue } from "./input-queue.js";
import { TurnRunner } from "./turn-runner.js";
import { TranscriptStore } from "../persistence/transcript-store.js";
import { reconstructSession, type ReconstructedSession } from "../persistence/reconstruction.js";
import type { RolloutWriter } from "../persistence/rollout-writer.js";
import type { TranscriptEnvelope, TranscriptKind, TranscriptPayload } from "../persistence/rollout-schema.js";
import { readRollout } from "../persistence/rollout-reader.js";
import { ContextManager } from "./context/context-manager.js";
import { CompactionFailure, CompactionManager, type CompactionRequestContext } from "./context/compaction-manager.js";
import type { CompactionHooks, CompactionResult, WorldStatePayload } from "./context/compaction-types.js";
import { ToolResultStorage } from "./context/tool-result-storage.js";
import { buildWorldState, contextCompatibilityFingerprint, referenceContext, renderWorldState, worldStateDiff } from "./context/world-state.js";
import { requestFingerprint } from "./context/token-accounting.js";
import { buildSpecPlan } from "../tools/spec-plan.js";
import { TaskGraphStore } from "./task-graph.js";
import { AgentManager } from "./agent-manager.js";
import { HookEngine } from "./hook-engine.js";

type PendingWork =
  | { type: "run"; request: string; signal?: AbortSignal; resolve: (result: AgentRunResult) => void; reject: (error: unknown) => void }
  | { type: "compact"; prompt?: string; signal?: AbortSignal; resolve: (result: CompactionResult) => void; reject: (error: unknown) => void }
  | { type: "rollback"; throughOrdinal: number; reason?: string; resolve: (state: ReconstructedSession) => void; reject: (error: unknown) => void }
  | { type: "shutdown" };

export interface SessionCoordinatorOptions {
  transcriptRoot?: string;
  sessionId?: SessionId;
  writer?: RolloutWriter;
  restoredState?: ReconstructedSession;
  compactionHooks?: CompactionHooks;
  initialMessages?: readonly Message[];
}

/** Serializes turns and owns the only live context, persistence, compaction, and cancellation. */
export class SessionCoordinator {
  private readonly ctx: AgentContext;
  private readonly sourceContext: AgentContext;
  private readonly sessionId: SessionId;
  private readonly sessionController = new AbortController();
  private readonly queue = new InputQueue<PendingWork>();
  private readonly steerQueue = new InputQueue<string>();
  private readonly turnRunner: TurnRunner;
  private readonly writer: RolloutWriter;
  private readonly context: ContextManager;
  private readonly compaction: CompactionManager;
  private readonly toolResults: ToolResultStorage;
  private readonly restoredState?: ReconstructedSession;
  private readonly initialMessages: readonly Message[];
  private readonly isNew: boolean;
  private state: SessionState = "created";
  private active = false;
  private activeTurnController: AbortController | undefined;
  private pumpStarted = false;
  private pumpPromise: Promise<void> | undefined;
  private initialized = false;
  private persistenceError: unknown;
  private pendingApprovalRequestId: string | undefined;

  constructor(
    ctx: AgentContext,
    private readonly onEvent?: (event: AgentEvent) => void,
    options: SessionCoordinatorOptions = {},
  ) {
    this.sourceContext = ctx;
    this.ctx = {
      ...ctx,
      workingMemory: structuredClone(ctx.workingMemory),
      taskGraph: undefined,
      agentManager: undefined,
      hooks: undefined,
    };
    const transcriptRoot = options.transcriptRoot ?? path.join(ctx.workspaceRoot, ".swe-agent", "sessions");
    const store = new TranscriptStore(transcriptRoot);
    this.restoredState = options.restoredState;
    this.initialMessages = options.initialMessages ? options.initialMessages.map((message) => structuredClone(message)) : [];
    this.sessionId = options.sessionId ?? options.restoredState?.sessionId ?? createSessionId();
    this.ctx.sessionId = this.sessionId;
    this.ctx.taskGraph = new TaskGraphStore(path.join(transcriptRoot, "tasks", `${this.sessionId}.json`), (event) => { void this.persist("task_event", event).catch(() => undefined); });
    this.ctx.agentManager = new AgentManager(this.ctx, path.join(transcriptRoot, "agents", this.sessionId), (event) => this.handleEvent(event), () => this.context?.messages() ?? []);
    this.writer = options.writer ?? store.createWriter(this.sessionId);
    this.ctx.hooks = new HookEngine(ctx.config.hooks ?? [], {
      onLifecycle: (record) => this.persist("hook_lifecycle", record).then(() => undefined).catch(() => undefined),
    });
    this.context = new ContextManager(options.restoredState ? {
      items: options.restoredState.annotatedHistory,
      window: options.restoredState.window,
      referenceContext: options.restoredState.referenceContext,
      worldState: options.restoredState.worldStateBaseline,
      latestCheckpointOrdinal: options.restoredState.latestCheckpointOrdinal,
      historyVersion: options.restoredState.historyVersion,
    } : undefined);
    this.toolResults = new ToolResultStorage(path.join(transcriptRoot, "artifacts", this.sessionId));
    this.compaction = new CompactionManager({
      ctx: this.ctx,
      context: this.context,
      persist: (kind, payload, context) => this.persist(kind, payload, context),
      hooks: {
        preCompact: async (event, signal) => {
          const configured = await this.ctx.hooks?.dispatch("PreCompact", event as unknown as Record<string, unknown>, this.ctx, signal);
          const custom = await options.compactionHooks?.preCompact?.(event, signal);
          return configured?.blocked || custom === "stop" ? "stop" : "continue";
        },
        postCompact: async (event, signal) => {
          const configured = await this.ctx.hooks?.dispatch("PostCompact", event as unknown as Record<string, unknown>, this.ctx, signal);
          const custom = await options.compactionHooks?.postCompact?.(event, signal);
          return configured?.blocked || custom === "stop" ? "stop" : "continue";
        },
      },
      onLifecycle: (status, payload) => this.handleEvent({ type: "compaction", status, ...payload }),
    });
    this.isNew = !options.restoredState;
    this.turnRunner = new TurnRunner(this.ctx);
  }

  run(request: string, signal?: AbortSignal): Promise<AgentRunResult> {
    if (this.state === "closing" || this.state === "closed") return Promise.reject(new Error("Session 已关闭"));
    return new Promise((resolve, reject) => {
      this.queue.push("user_input", { type: "run", request, signal, resolve, reject });
      this.startPump();
    });
  }

  compact(prompt?: string, signal?: AbortSignal): Promise<CompactionResult> {
    if (this.state === "closing" || this.state === "closed") return Promise.reject(new Error("Session 已关闭"));
    return new Promise((resolve, reject) => {
      this.queue.push("manual_compact", { type: "compact", prompt, signal, resolve, reject });
      this.startPump();
    });
  }

  rollback(throughOrdinal: number, reason?: string): Promise<ReconstructedSession> {
    if (this.state === "closing" || this.state === "closed") return Promise.reject(new Error("Session 已关闭"));
    return new Promise((resolve, reject) => {
      this.queue.push("background", { type: "rollback", throughOrdinal, reason, resolve, reject });
      this.startPump();
    });
  }

  interrupt(reason = "用户中断"): void {
    this.activeTurnController?.abort(new Error(reason));
    this.ctx.agentManager?.cancelAll(reason);
    void this.ctx.hooks?.dispatch("Interrupt", { sessionId: this.sessionId, reason }, this.ctx).catch(() => undefined);
  }
  steer(text: string): void {
    if (this.state !== "closing" && this.state !== "closed") this.steerQueue.push("steer", text);
  }
  shutdown(reason = "session shutdown"): void {
    if (!this.sessionController.signal.aborted) this.sessionController.abort(new Error(reason));
    this.activeTurnController?.abort(new Error(reason));
    this.ctx.agentManager?.cancelAll(reason);
    this.setState("closing");
    if (!this.pumpStarted) {
      this.setState("closed");
      void this.writer.shutdown();
      return;
    }
    this.queue.push("shutdown", { type: "shutdown" });
  }
  async close(reason?: string): Promise<void> {
    this.shutdown(reason);
    await this.pumpPromise;
    await this.writer.shutdown();
  }
  async flush(): Promise<void> {
    await this.writer.flush();
    if (this.persistenceError) throw this.persistenceError;
  }

  get sessionState(): SessionState { return this.state; }
  get hasActiveTurn(): boolean { return this.active; }
  get id(): SessionId { return this.sessionId; }
  get transcriptPath(): string { return this.writer.filePath; }
  get recovery(): ReconstructedSession | undefined { return this.restoredState; }
  get tasks() { return this.ctx.taskGraph?.list() ?? []; }

  private startPump(): void {
    if (this.pumpStarted) return;
    this.pumpStarted = true;
    this.pumpPromise = this.pump();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.ctx.taskGraph?.load();
    await this.ctx.agentManager?.load();
    const startHook = await this.ctx.hooks?.dispatch("SessionStart", { sessionId: this.sessionId, cwd: this.ctx.workspaceRoot }, this.ctx);
    if (startHook?.blocked) throw new Error(startHook.reason ?? "SessionStart hook blocked session");
    if (this.isNew) {
      await this.writer.append("session_meta", {
        cwd: this.ctx.workspaceRoot,
        model: this.ctx.config.model.model,
        initialWindowId: this.context.window.snapshot().windowId,
      }, { durable: true });
      for (const message of this.initialMessages) await this.appendMessage(message, {});
    } else if (this.restoredState && (this.restoredState.incompleteTurnIds.length > 0 || this.restoredState.unknownOutcomes.length > 0)) {
      const marker = {
        incompleteTurnIds: this.restoredState.incompleteTurnIds,
        unknownOutcomeCallIds: this.restoredState.unknownOutcomes.map((outcome) => outcome.callId),
      };
      await this.writer.append("interruption_marker", marker);
      await this.appendMessage({
        role: "system",
        content: `上次会话被中断。未完成 turn: ${marker.incompleteTurnIds.length}；结果未知的工具调用: ${marker.unknownOutcomeCallIds.join(", ") || "无"}。不得自动重放这些工具调用。`,
      }, {});
    }
    this.handleEvent({ type: "session_started", sessionId: this.sessionId });
    this.handleEvent({ type: "session_state_changed", sessionId: this.sessionId, state: "created" });
  }

  private async pump(): Promise<void> {
    try {
      await this.initialize();
      this.setState("ready");
      while (!this.sessionController.signal.aborted) {
        const entry = await this.queue.wait();
        if (entry.kind === "shutdown" || entry.value.type === "shutdown") break;
        const pending = entry.value;
        this.active = true;
        this.setState("running");
        this.activeTurnController = new AbortController();
        try {
          if (pending.type === "run") await this.runPending(pending);
          else if (pending.type === "compact") await this.compactPending(pending);
          else if (pending.type === "rollback") await this.rollbackPending(pending);
        } catch (error) {
          pending.reject(error);
          if (error instanceof CompactionFailure && error.committed) {
            this.persistenceError = error;
            this.sessionController.abort(error);
          }
        } finally {
          this.activeTurnController = undefined;
          this.active = false;
          if (!this.sessionController.signal.aborted) this.setState("ready");
        }
      }
    } catch (error) {
      this.persistenceError = error;
    } finally {
      this.setState("closed");
      this.rejectPending(this.persistenceError ? `Session 持久化失败: ${errorText(this.persistenceError)}` : "Session 已关闭");
      await this.writer.shutdown().catch((error) => { this.persistenceError ??= error; });
      await this.ctx.agentManager?.close().catch((error) => { this.persistenceError ??= error; });
      await this.ctx.hooks?.dispatch("SessionEnd", { sessionId: this.sessionId, state: this.state }, this.ctx).catch(() => undefined);
    }
  }

  private async runPending(pending: Extract<PendingWork, { type: "run" }>): Promise<void> {
    this.syncExternalContext();
    const signal = linkedSignal(this.sessionController.signal, pending.signal, this.activeTurnController?.signal);
    try {
      const result = await this.turnRunner.run({
        sessionId: this.sessionId,
        userRequest: pending.request,
        signal,
        context: this.context,
        consumeSteer: () => this.steerQueue.take()?.value,
        maybeCompact: (input) => this.maybeCompact(input),
        prepareContext: (context) => this.ensureContextBaseline(context),
        appendMessage: (message, context) => this.appendMessage(message, context),
        persistToolResult: (call, context) => this.persistToolResult(call, context),
        persist: async (kind, payload, context) => { await this.persist(kind, payload, context); },
        onEvent: (event) => this.handleEvent(event),
      });
      await this.ctx.hooks?.dispatch("Stop", { sessionId: this.sessionId, turnId: result.turnId, reason: result.terminalReason }, this.ctx, signal);
      await this.flush();
      this.active = false;
      pending.resolve({ ...result, history: this.context.messages() });
    } catch (error) {
      await this.ctx.hooks?.dispatch("Stop", { sessionId: this.sessionId, reason: errorText(error), failed: true }, this.ctx, signal).catch(() => undefined);
      throw error;
    }
  }

  private syncExternalContext(): void {
    const source = this.sourceContext;
    this.ctx.agentMemories = source.agentMemories;
    this.ctx.contextualFragments = source.contextualFragments;
    this.ctx.instructionSnapshot = source.instructionSnapshot;
    this.ctx.skillSnapshot = source.skillSnapshot;
    this.ctx.selectedSkills = source.selectedSkills;
    this.ctx.configStack = source.configStack;
    this.ctx.contextFileSystem = source.contextFileSystem;
    this.ctx.skillPlatform = source.skillPlatform;
    this.ctx.skillTokenizer = source.skillTokenizer;
    this.ctx.config = source.config;
    this.ctx.hooks?.replace(source.config.hooks ?? []);
  }

  private async compactPending(pending: Extract<PendingWork, { type: "compact" }>): Promise<void> {
    const signal = linkedSignal(this.sessionController.signal, pending.signal, this.activeTurnController?.signal);
    const turnId = createTurnId();
    await this.persist("turn_started", { userRequest: "[manual compact]" }, { turnId });
    try {
      const result = await this.compaction.compact({
        trigger: "manual", reason: "user_requested", phase: "standalone_turn", signal, turnId,
        ...(pending.prompt ? { prompt: pending.prompt } : {}),
      });
      await this.persist("turn_completed", { reason: "completed" }, { turnId });
      await this.flush();
      this.active = false;
      pending.resolve(result);
    } catch (error) {
      await this.persist("turn_aborted", { reason: errorText(error) }, { turnId }).catch(() => undefined);
      throw error;
    }
  }

  private async rollbackPending(pending: Extract<PendingWork, { type: "rollback" }>): Promise<void> {
    await this.flush();
    const before = await readRollout(this.writer.filePath, { repairPartialTail: false });
    const target = before.records.find((record) => record.ordinal === pending.throughOrdinal);
    if (!target) throw new Error(`rollback ordinal 不存在: ${pending.throughOrdinal}`);
    if (!["session_meta", "turn_completed", "turn_aborted", "compact_checkpoint", "world_state", "reference_context"].includes(target.kind)) {
      throw new Error("rollback 必须落在完整 turn 或 checkpoint/baseline 边界");
    }
    await this.persist("rollback", {
      throughOrdinal: pending.throughOrdinal,
      ...(pending.reason ? { reason: pending.reason } : {}),
    }, { durable: true });
    await this.flush();
    const state = reconstructSession((await readRollout(this.writer.filePath, { repairPartialTail: false })).records);
    this.context.restore({
      items: state.annotatedHistory,
      window: state.window,
      referenceContext: state.referenceContext,
      worldState: state.worldStateBaseline,
      latestCheckpointOrdinal: state.latestCheckpointOrdinal,
      historyVersion: state.historyVersion,
    });
    this.active = false;
    pending.resolve(state);
  }

  private async ensureContextBaseline(context: { turnId: TurnId }): Promise<void> {
    const input = { ctx: this.ctx, tools: this.ctx.registry.visibleSpecs() };
    const current = buildWorldState(input);
    const previous = this.context.worldState();
    const update = worldStateDiff(previous, current, !this.context.referenceContext());
    if (!update) return;
    await this.appendMessage({ role: "system", content: renderWorldState(update) }, context, "context_injection");
    const compHash = this.compHash();
    const reference = referenceContext(current, input, compHash);
    await this.persist("world_state", update, { ...context, durable: true });
    await this.persist("reference_context", reference, { ...context, durable: true });
    this.context.applyWorldState(update);
    this.context.setReference(reference);
  }

  private async maybeCompact(
    input: Omit<CompactionRequestContext, "trigger" | "reason">,
  ): Promise<CompactionResult | undefined> {
    const currentWorld = buildWorldState({ ctx: this.ctx, tools: this.ctx.registry.visibleSpecs() });
    const pendingWorld = worldStateDiff(this.context.worldState(), currentWorld, !this.context.referenceContext());
    const projected = pendingWorld
      ? { ...input, pendingMessages: [
        { role: "system" as const, content: renderWorldState(pendingWorld) },
        ...(input.pendingMessages ?? []),
      ] }
      : input;
    if (input.phase === "pre_turn") {
      const previous = this.context.referenceContext();
      if (
        previous?.model && previous.model !== this.ctx.config.model.model
        && previous.contextLimit !== undefined && this.ctx.config.maxContextTokens < previous.contextLimit
      ) {
        return this.compaction.compact({ ...projected, trigger: "auto", reason: "model_downshift" });
      }
      if (previous?.compHash && previous.compHash !== this.compHash()) {
        return this.compaction.compact({ ...projected, trigger: "auto", reason: "comp_hash_changed" });
      }
    }
    return this.compaction.maybeCompact(projected);
  }

  private async appendMessage(
    message: Message,
    context: { turnId?: TurnId; stepId?: StepId },
    kind: "conversation" | "context_injection" = "conversation",
  ): Promise<Message> {
    let normalized = structuredClone(message);
    if (normalized.role === "tool" && normalized.toolCallId) {
      const stored = await this.toolResults.store(normalized.name ?? "tool", normalized.toolCallId, normalized.content);
      normalized = { ...normalized, content: stored.output };
    }
    const usageAnchor = normalized.requestId && normalized.usage
      ? this.context.usageAnchor(
        normalized.requestId,
        this.context.historyVersion(),
        requestFingerprint({
        messages: [], tools: buildSpecPlan(this.ctx.registry).definitions,
          maxOutputTokens: this.ctx.config.maxOutputTokens,
          model: this.ctx.config.model.model,
        }),
        true,
      )
      : undefined;
    const item = this.context.prepareMessage(normalized, {
      kind,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      ...(context.stepId ? { stepId: context.stepId } : {}),
      ...(usageAnchor ? { usageAnchor } : {}),
    });
    await this.persist("message", { item }, context);
    this.context.recordPersisted(item);
    this.handleEvent({ type: "response_item", sessionId: this.sessionId, ...(context.turnId ? { turnId: context.turnId } : {}), ...(context.stepId ? { stepId: context.stepId } : {}), item });
    return structuredClone(normalized);
  }

  private async persistToolResult(
    call: { callId: CallId; result: ToolResult },
    context: { turnId: TurnId; stepId: StepId },
  ): Promise<ToolResult> {
    const stored = await this.toolResults.store(call.result.toolName, call.callId, call.result.output);
    const result: ToolResult = {
      ...call.result,
      output: stored.output,
      metadata: {
        ...(call.result.metadata ?? {}),
        ...(stored.persisted ? {
          persisted: true,
          filePath: stored.filePath,
          sha256: stored.sha256,
          originalCharacters: stored.originalCharacters,
        } : {}),
      },
    };
    await this.persist("tool_result", { callId: call.callId, result }, context);
    return result;
  }

  private persist(
    kind: TranscriptKind,
    payload: TranscriptPayload,
    context: { turnId?: TurnId; stepId?: StepId; durable?: boolean } = {},
  ): Promise<TranscriptEnvelope> {
    return this.writer.append(kind, payload, context);
  }

  private compHash(): string {
    return contextCompatibilityFingerprint({ ctx: this.ctx, tools: this.ctx.registry.visibleSpecs() });
  }

  private handleEvent(event: AgentEvent): void {
    this.ctx.observability?.onEvent(event);
    if (event.type === "subagent_started") this.enqueuePersistence("agent_event", { agentId: event.agentId, event: "started", ...(event.parentSessionId ? { parentSessionId: event.parentSessionId } : {}), prompt: event.prompt });
    if (event.type === "subagent_completed") this.enqueuePersistence("agent_event", { agentId: event.agentId, event: "completed", status: event.status, ...(event.result ? { result: event.result } : {}), ...(event.error ? { error: event.error } : {}) });
    if (event.type === "approval_requested") {
      this.setState("waiting_approval");
      this.pendingApprovalRequestId = event.request.requestId;
      this.enqueuePersistence("approval_requested", {
        requestId: event.request.requestId,
        callId: event.request.preview.callId,
        permissionFingerprint: event.request.permissionFingerprint,
      });
    }
    if (event.type === "approval_resolved") {
      if (!this.sessionController.signal.aborted) this.setState("running");
      this.enqueuePersistence("approval_resolved", { requestId: this.pendingApprovalRequestId, result: event.result });
      this.pendingApprovalRequestId = undefined;
    }
    if (event.type === "tool_preview") {
      this.enqueuePersistence("tool_preview", {
        callId: event.preview.callId, toolName: event.preview.toolName, summary: event.preview.summary,
        risk: event.preview.risk, cwd: event.preview.cwd, affectedPaths: event.preview.affectedPaths, reasons: event.preview.reasons,
      });
    }
    this.onEvent?.(event);
  }

  private enqueuePersistence(kind: TranscriptKind, payload: TranscriptPayload): void {
    void this.writer.append(kind, payload).catch((error) => { this.persistenceError ??= error; });
  }
  private setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handleEvent({ type: "session_state_changed", sessionId: this.sessionId, state });
  }
  private rejectPending(message: string): void {
    let entry: ReturnType<InputQueue<PendingWork>["take"]>;
    while ((entry = this.queue.take())) {
      if (entry.value.type !== "shutdown") entry.value.reject(new Error(message));
    }
  }
}

function linkedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => controller.abort(signal.reason ?? new Error("操作已取消"));
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) abort(signal);
    else {
      const listener = () => abort(signal);
      signal.addEventListener("abort", listener, { once: true });
      listeners.push({ signal, listener });
    }
  }
  controller.signal.addEventListener("abort", () => {
    for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
  }, { once: true });
  return controller.signal;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
