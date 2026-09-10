import type { AgentContext, AgentRunResult, AgentStep, CompletedTaskSummary, Message, Task } from "../types.js";
import type { SessionId, StepId, TurnId } from "../protocol/ids.js";
import { createRequestId, createStepId, createTurnId } from "../protocol/ids.js";
import type { ModelMessage, ModelRequest } from "../protocol/model-events.js";
import { modelTransportFor } from "../model/transport.js";
import type { AgentEvent, TurnState, TurnTerminalReason } from "./events.js";
import { Executor } from "./executor.js";
import { OutputParser } from "./output-parser.js";
import { PromptBuilder } from "./prompt-builder.js";
import { TaskPlanner } from "./task-planner.js";
import { TaskScheduler } from "./task-scheduler.js";
import { runStep } from "./turn.js";
import type { TranscriptKind, TranscriptPayload } from "../persistence/rollout-schema.js";
import type { ContextManager } from "./context/context-manager.js";
import { CompactionFailure, type CompactionRequestContext } from "./context/compaction-manager.js";
import type { CompactionResult } from "./context/compaction-types.js";
import type { ToolResult } from "../types.js";
import { buildSpecPlan, type SpecPlan } from "../tools/spec-plan.js";
import { extractSkillMentions } from "../config/skills.js";
import { refreshContextualFragments } from "../config/context-loader.js";

export interface TurnRunnerOptions {
  sessionId: SessionId;
  userRequest: string;
  signal: AbortSignal;
  consumeSteer?: () => string | undefined;
  onEvent?: (event: AgentEvent) => void;
  context: ContextManager;
  maybeCompact: (input: Omit<CompactionRequestContext, "trigger" | "reason">) => Promise<CompactionResult | undefined>;
  prepareContext: (context: { turnId: TurnId }) => Promise<void>;
  appendMessage: (message: Message, context: { turnId: TurnId; stepId?: StepId }) => Promise<Message>;
  persistToolResult: (call: { callId: import("../protocol/ids.js").CallId; result: ToolResult }, context: { turnId: TurnId; stepId: StepId }) => Promise<ToolResult>;
  persist?: (kind: TranscriptKind, payload: TranscriptPayload, context?: { turnId?: TurnId; stepId?: StepId }) => Promise<void>;
}

/** Owns one turn's state machine and its model/tool continuation loop. */
export class TurnRunner {
  private readonly parser = new OutputParser();
  private readonly promptBuilder = new PromptBuilder();
  private readonly executor = new Executor();
  private readonly planner: TaskPlanner;

  constructor(private readonly ctx: AgentContext) {
    this.planner = new TaskPlanner(ctx.model, ctx.config.useLlmPlanning);
  }

  async run(options: TurnRunnerOptions): Promise<AgentRunResult> {
    const { ctx } = this;
    const turnId = createTurnId();
    const explicitSkills = extractSkillMentions(options.userRequest);
    const promptHook = await ctx.hooks?.dispatch("UserPromptSubmit", { text: options.userRequest, sessionId: options.sessionId }, ctx, options.signal);
    if (promptHook?.blocked) throw new Error(promptHook.reason ?? "UserPromptSubmit hook blocked request");
    const refreshed = await refreshContextualFragments(ctx, explicitSkills, options.userRequest);
    const selectionErrors = refreshed.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (selectionErrors.length > 0) throw new Error(selectionErrors.map((diagnostic) => diagnostic.message).join("；"));
    const history: Message[] = options.context.messages();
    const trace: AgentStep[] = [];
    const completedTasks: CompletedTaskSummary[] = [];
    const specPlan: SpecPlan = buildSpecPlan(ctx.registry);
    const contextualFragments = [...(ctx.contextualFragments ?? [])];
    const memories = ctx.memoryStore?.relevant(options.userRequest) ?? [];
    if (memories.length > 0) {
      const memoryText = boundedMemoryText(memories, ctx, Math.min(1_500, Math.max(256, Math.floor(ctx.config.maxContextTokens * 0.1))));
      contextualFragments.push({
        role: "user",
        type: "memory.retrieval",
        text: `<relevant_memory>\n${memoryText}\n</relevant_memory>`,
        hash: `memory:${ctx.memoryStore?.fingerprint() ?? ""}`,
        source: "memory-store",
      });
    }
    const scheduler = new TaskScheduler(ctx.taskGraph);
    let steps = 0;
    let currentTask: Task | undefined;
    let terminalReason: TurnTerminalReason = "failed";
    let finalAnswer = "任务执行失败。";

    await options.persist?.("turn_started", { userRequest: options.userRequest }, { turnId });
    this.emit(options, { type: "turn_started", sessionId: options.sessionId, turnId });
    const userMessage: Message = { role: "user", content: String(promptHook?.rewrittenInput?.text ?? options.userRequest) };
    if (promptHook?.additionalContext) contextualFragments.push({ role: "user", type: "agents_md.instructions", text: promptHook.additionalContext, hash: "hook-context", source: "hook" });
    this.setState(options, turnId, "preflight_context");

    try {
      this.setState(options, turnId, "precompact");
      const precompact = await options.maybeCompact({
        phase: "pre_turn",
        signal: options.signal,
        turnId,
        pendingMessages: [userMessage],
      });
      if (precompact) {
        history.splice(0, history.length, ...options.context.messages());
        this.emit(options, { type: "compact_boundary" });
        if (precompact.postHookStopped) throw new Error("PostCompact hook 已停止当前 turn");
      }
      await options.prepareContext({ turnId });
      history.splice(0, history.length, ...options.context.messages());
      history.push(await options.appendMessage(userMessage, { turnId }));
      scheduler.push(await this.planner.plan(options.userRequest));

      while (steps < ctx.config.maxSteps) {
        throwIfAborted(options.signal);
        if (!currentTask) {
          currentTask = scheduler.next(options.sessionId);
          if (!currentTask) {
            terminalReason = "task_queue_empty";
            finalAnswer = "任务队列为空，任务未完成。";
            break;
          }
        }

        const task = currentTask;
        const stepId = createStepId();
        const stepIndex = steps;
        this.setState(options, turnId, "precompact");
        this.emit(options, { type: "step_started", sessionId: options.sessionId, turnId, stepId });
        let stepCompleted = false;

        try {
          this.setState(options, turnId, "compacting");
          const compacted = await options.maybeCompact({
            phase: "mid_turn",
            signal: options.signal,
            turnId,
            stepId,
            task,
            completedTasks,
          });
          if (compacted) {
            history.splice(0, history.length, ...options.context.messages());
            this.emit(options, { type: "compact_boundary" });
            if (compacted.postHookStopped) throw new Error("PostCompact hook 已停止当前 turn");
          }
          const steer = options.consumeSteer?.();
          if (steer) {
            const steerMessage: Message = { role: "user", content: steer };
            history.push(await options.appendMessage(steerMessage, { turnId, stepId }));
          }

          const transport = modelTransportFor(ctx.model);
          const nativeToolCalls = transport.capabilities().nativeToolCalls;
          const buildMessages = () => this.promptBuilder.build({
            messages: history,
            currentTask: task,
            completedTasks,
            workingMemory: ctx.workingMemory,
            tools: specPlan.tools.map((tool) => tool.spec),
            config: ctx.config,
            agentMemories: ctx.agentMemories,
            nativeToolCalls,
            contextualFragments,
          });
          const generate = () => {
            const messages = buildMessages();
            const request: ModelRequest = {
              requestId: createRequestId(),
              items: options.context.annotatedItems(),
              messages: messages.map(toModelMessage),
              tools: specPlan.definitions,
              temperature: 0,
              maxOutputTokens: ctx.config.maxOutputTokens,
            };
            return transport.stream(request, options.signal);
          };

          this.setState(options, turnId, "sampling");
          let step: Awaited<ReturnType<typeof runStep>>;
          try {
            step = await runStep({
              history,
              generate,
              parser: this.parser,
              knownTools: ctx.registry.names(),
              executor: this.executor,
              ctx,
              parseRetry: ctx.config.parseRetry,
              nativeToolCalls,
              signal: options.signal,
              onMessageAppended: (message) => options.appendMessage(message, { turnId, stepId }),
              onToolCallStarted: (call) => options.persist?.("tool_call", {
                callId: call.callId,
                name: call.name,
                input: call.input,
                sideEffecting: !ctx.registry.isReadOnly(call.name),
              }, { turnId, stepId }) ?? Promise.resolve(),
              onToolCallCompleted: (call) => options.persistToolResult(call, { turnId, stepId }),
              onEvent: (event) => {
                if (event.type === "tool_use_started") this.setState(options, turnId, "dispatching_tools");
                this.emit(options, event.type === "model_event" ? { ...event, sessionId: options.sessionId, turnId, stepId } : event);
              },
            });
          } catch (error) {
            this.emit(options, { type: "step_completed", sessionId: options.sessionId, turnId, stepId });
            throw error;
          }
          steps += 1;
          this.emit(options, {
            type: "step_completed",
            sessionId: options.sessionId,
            turnId,
            stepId,
            continueReason: step.continueReason,
          });
          stepCompleted = true;

          if (step.action === null) {
            task.status = "failed";
            terminalReason = "parse_failed";
            finalAnswer = step.finalAnswerText ?? "连续解析失败，终止任务。";
            trace.push(this.traceStep(stepIndex, step, options.sessionId, turnId, stepId));
            break;
          }

          const action = step.action;
          trace.push(this.traceStep(stepIndex, step, options.sessionId, turnId, stepId));
          if (action.type === "final_answer") {
            scheduler.taskGraph.complete(task.id, action.answer);
            completedTasks.push({ description: task.description, result: action.answer });
            finalAnswer = action.answer;
            this.emit(options, { type: "final_answer", answer: action.answer });
            if (scheduler.isEmpty()) {
              terminalReason = "completed";
              break;
            }
            currentTask = undefined;
            this.setState(options, turnId, "awaiting_followup");
            continue;
          }

          this.setState(options, turnId, "dispatching_tools");
          this.setState(options, turnId, "awaiting_followup");
        } catch (error) {
          if (!stepCompleted) {
            this.emit(options, { type: "step_completed", sessionId: options.sessionId, turnId, stepId });
          }
          throw error;
        }
      }

      if (terminalReason === "failed" && steps >= ctx.config.maxSteps) {
        terminalReason = "max_steps";
        finalAnswer = "达到最大步数，任务未完成。";
        this.emit(options, { type: "max_steps_reached" });
      }
    } catch (error) {
      if (options.signal.aborted) {
        terminalReason = "cancelled";
        finalAnswer = "任务已取消。";
        await options.persist?.("turn_aborted", { reason: reasonText(options.signal.reason) }, { turnId });
        this.emit(options, { type: "turn_aborted", sessionId: options.sessionId, turnId, reason: reasonText(options.signal.reason) });
      } else {
        terminalReason = "failed";
        finalAnswer = error instanceof Error ? `任务执行失败: ${error.message}` : `任务执行失败: ${String(error)}`;
        this.emit(options, { type: "api_error", error: error instanceof Error ? error : new Error(String(error)), recoverable: false });
        if (error instanceof CompactionFailure && error.committed) {
          await options.persist?.("turn_aborted", { reason: error.message }, { turnId });
          this.emit(options, { type: "turn_aborted", sessionId: options.sessionId, turnId, reason: error.message });
          throw error;
        }
      }
    }

    const finalState: TurnState = terminalReason === "cancelled"
      ? "aborted"
      : terminalReason === "failed" || terminalReason === "parse_failed"
        ? "failed"
        : "completed";
    this.setState(options, turnId, finalState);
    await options.persist?.("turn_completed", { reason: terminalReason }, { turnId });
    this.emit(options, { type: "turn_completed", sessionId: options.sessionId, turnId, reason: terminalReason });
    return { answer: finalAnswer, steps, history, taskTrace: trace, sessionId: options.sessionId, turnId, terminalReason };
  }

  private traceStep(index: number, step: Awaited<ReturnType<typeof runStep>>, sessionId: SessionId, turnId: TurnId, stepId: StepId): AgentStep {
    return {
      index,
      action: step.action ?? { type: "final_answer", thought: "解析失败", answer: step.finalAnswerText ?? "" },
      observation: step.observation,
      rawOutput: step.raw,
      timestamp: Date.now(),
      sessionId,
      turnId,
      stepId,
      requestId: step.requestId,
      usage: step.usage,
      continueReason: step.continueReason,
      reasoning: step.reasoning,
      finishReason: step.finishReason,
    };
  }

  private emit(options: TurnRunnerOptions, event: AgentEvent): void {
    options.onEvent?.(event);
  }

  private setState(options: TurnRunnerOptions, turnId: TurnId, state: TurnState): void {
    options.onEvent?.({ type: "turn_state_changed", sessionId: options.sessionId, turnId, state });
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Turn 已取消");
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : reason ? String(reason) : "外部中断";
}

function boundedMemoryText(memories: readonly import("./memory-store.js").MemoryRecord[], ctx: AgentContext, maxTokens: number): string {
  const lines: string[] = [];
  for (const memory of memories) {
    const line = `[${memory.kind}; confidence=${memory.confidence.toFixed(2)}; provenance=${memory.provenance}] ${memory.content}`;
    const candidate = [...lines, line].join("\n");
    const tokens = ctx.skillTokenizer?.count(candidate, ctx.config.model.model) ?? Math.ceil(candidate.length / 4);
    if (tokens > maxTokens) break;
    lines.push(line);
  }
  return lines.join("\n");
}

function toModelMessage(message: Message): ModelMessage {
  return {
    role: message.role,
    content: message.content,
    name: message.name,
    usage: message.usage,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
  };
}
