// 会话生命周期：一次 run 是 Turn，内部按 Step 推进模型请求和工具处理。
// 单步推进委托给 runStep，AgentSession 负责任务规划、预算、结果和事件分发。

import type {
  AgentContext,
  AgentRunResult,
  AgentStep,
  CompletedTaskSummary,
  Message,
  Task,
} from "../types.js";
import type { AgentEvent } from "./events.js";
import { Executor } from "./executor.js";
import { OutputParser } from "./output-parser.js";
import { PromptBuilder } from "./prompt-builder.js";
import { TaskPlanner } from "./task-planner.js";
import { TaskScheduler } from "./task-scheduler.js";
import { runStep } from "./turn.js";
import { CompactionPipeline } from "./context/compaction-pipeline.js";
import { ToolResultStorage } from "./context/tool-result-storage.js";
import { createRequestId, createSessionId, createStepId, createTurnId } from "../protocol/ids.js";
import type { ModelMessage, ModelRequest } from "../protocol/model-events.js";
import { modelTransportFor } from "../model/transport.js";
import { qualifiedName } from "../tools/registry.js";

export class AgentSession {
  private scheduler = new TaskScheduler();
  private promptBuilder = new PromptBuilder();
  private parser = new OutputParser();
  private executor = new Executor();
  private planner: TaskPlanner;
  private events: AgentEvent[] = [];
  private compaction: CompactionPipeline;

  constructor(
    private ctx: AgentContext,
    private onEvent?: (e: AgentEvent) => void,
  ) {
    this.planner = new TaskPlanner(ctx.model, ctx.config.useLlmPlanning);
    this.compaction = new CompactionPipeline(new ToolResultStorage(`${ctx.workspaceRoot}/.swe-agent/session`));
  }

  private emit(e: AgentEvent): void {
    this.events.push(e);
    this.onEvent?.(e);
  }

  async run(userRequest: string): Promise<AgentRunResult> {
    const { ctx } = this;
    const sessionId = createSessionId();
    this.emit({ type: "session_started", sessionId });
    const turnId = createTurnId();
    this.emit({ type: "turn_started", sessionId, turnId });
    const tasks = await this.planner.plan(userRequest);
    this.scheduler.push(tasks);

    const history: Message[] = [{ role: "user", content: userRequest }];
    const trace: AgentStep[] = [];
    const completedTasks: CompletedTaskSummary[] = [];
    const transport = modelTransportFor(ctx.model);
    let steps = 0;
    let currentTask: Task | undefined;

    while (steps < ctx.config.maxSteps) {
      if (!currentTask) {
        currentTask = this.scheduler.next();
        if (!currentTask) break;
      }
      const task = currentTask;
      const stepId = createStepId();
      const stepIndex = steps;
      this.emit({ type: "step_started", sessionId, turnId, stepId });

      const compacted = await this.compaction.compact(history, {
        budgetTokens: ctx.config.maxContextTokens,
        recentFiles: this.recentFiles(ctx),
      });
      history.splice(0, history.length, ...compacted.messages);
      if (compacted.report.persistedToolResults > 0 || compacted.report.clearedToolResults > 0 || compacted.report.collapsedTurns > 0 || compacted.report.summarized) {
        this.emit({ type: "compact_boundary" });
      }

      const buildMessages = () =>
        this.promptBuilder.build({
          messages: history,
          currentTask: task,
          completedTasks,
          workingMemory: ctx.workingMemory,
          tools: ctx.registry.visibleSpecs(),
          config: ctx.config,
          agentMemories: ctx.agentMemories,
        });

      // 优先流式；不支持 stream 的模型回退为 chat 包装成生成器
      const generate = () => {
        const messages = buildMessages();
        const request: ModelRequest = {
          requestId: createRequestId(),
          messages: messages.map(toModelMessage),
          tools: ctx.registry.visibleSpecs().map((tool) => ({ name: qualifiedName(tool), description: tool.description, parameters: tool.parameters })),
          temperature: 0,
          maxOutputTokens: ctx.config.maxOutputTokens,
        };
        return transport.stream(request, new AbortController().signal);
      };

      const step = await runStep({
        history,
        generate,
        parser: this.parser,
        knownTools: ctx.registry.names(),
        executor: this.executor,
        ctx,
        parseRetry: ctx.config.parseRetry,
        nativeToolCalls: transport.capabilities().nativeToolCalls,
        onEvent: (e) => this.emit(e),
      });
      steps += 1;
      this.emit({ type: "step_completed", sessionId, turnId, stepId });

      if (step.action === null) {
        task.status = "failed";
        trace.push({
          index: stepIndex,
          action: {
            type: "final_answer",
            thought: "解析失败",
            answer: step.finalAnswerText ?? "",
          },
          rawOutput: step.raw,
          timestamp: Date.now(),
          sessionId,
          turnId,
          stepId,
          requestId: step.requestId,
          usage: step.usage,
        });
        break;
      }

      const action = step.action;
      if (action.type === "final_answer") {
        task.status = "done";
        completedTasks.push({ description: task.description, result: action.answer });
        trace.push({
          index: stepIndex,
          action,
          rawOutput: step.raw,
          timestamp: Date.now(),
          sessionId,
          turnId,
          stepId,
          requestId: step.requestId,
          usage: step.usage,
        });
        this.emit({ type: "final_answer", answer: action.answer });
        if (this.scheduler.isEmpty()) {
          this.emit({ type: "turn_completed", sessionId, turnId });
          return { answer: action.answer, steps, history, taskTrace: trace, sessionId, turnId };
        }
        currentTask = undefined;
        continue;
      }

      trace.push({
        index: stepIndex,
        action,
        observation: step.observation,
        rawOutput: step.raw,
        timestamp: Date.now(),
        sessionId,
        turnId,
        stepId,
        requestId: step.requestId,
        usage: step.usage,
      });
    }

    const answer = "达到最大步数或任务队列为空，任务未完成。";
    this.emit({ type: "turn_completed", sessionId, turnId });
    if (steps >= ctx.config.maxSteps) this.emit({ type: "max_steps_reached" });
    return { answer, steps, history, taskTrace: trace, sessionId, turnId };
  }
  private recentFiles(ctx: AgentContext): string[] {
    return [ctx.workingMemory.lastReadFile, ctx.workingMemory.lastWrittenFile].filter(
      (file): file is string => typeof file === "string",
    );
  }
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

