// 会话生命周期（双层结构的外层）：任务规划、步数/预算控制、结果提取、事件分发。
// 单轮推进委托给 runTurn（内层），对齐 Claude Code QueryEngine / Codex Session。

import type {
  AgentContext,
  AgentRunResult,
  AgentStep,
  CompletedTaskSummary,
  Message,
  ModelStreamEvent,
  Task,
} from "../types.js";
import type { AgentEvent } from "./events.js";
import { Executor } from "./executor.js";
import { OutputParser } from "./output-parser.js";
import { PromptBuilder } from "./prompt-builder.js";
import { StreamingToolExecutor } from "./streaming-executor.js";
import { TaskPlanner } from "./task-planner.js";
import { TaskScheduler } from "./task-scheduler.js";
import { runTurn } from "./turn.js";
import { CompactionPipeline } from "./context/compaction-pipeline.js";
import { ToolResultStorage } from "./context/tool-result-storage.js";

export class AgentSession {
  private scheduler = new TaskScheduler();
  private promptBuilder = new PromptBuilder();
  private parser = new OutputParser();
  private executor = new Executor();
  private streamingExecutor: StreamingToolExecutor;
  private planner: TaskPlanner;
  private events: AgentEvent[] = [];
  private compaction: CompactionPipeline;

  constructor(
    private ctx: AgentContext,
    private onEvent?: (e: AgentEvent) => void,
  ) {
    this.planner = new TaskPlanner(ctx.model, ctx.config.useLlmPlanning);
    this.streamingExecutor = new StreamingToolExecutor(ctx, ctx.registry, this.executor);
    this.compaction = new CompactionPipeline(new ToolResultStorage(`${ctx.workspaceRoot}/.swe-agent/session`));
  }

  private emit(e: AgentEvent): void {
    this.events.push(e);
    this.onEvent?.(e);
  }

  async run(userRequest: string): Promise<AgentRunResult> {
    const { ctx } = this;
    const tasks = await this.planner.plan(userRequest);
    this.scheduler.push(tasks);

    const history: Message[] = [{ role: "user", content: userRequest }];
    const trace: AgentStep[] = [];
    const completedTasks: CompletedTaskSummary[] = [];
    let steps = 0;
    let currentTask: Task | undefined;

    while (steps < ctx.config.maxSteps) {
      if (!currentTask) {
        currentTask = this.scheduler.next();
        if (!currentTask) break;
      }
      const task = currentTask;

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
          tools: ctx.registry.list(),
          config: ctx.config,
          agentMemories: ctx.agentMemories,
        });

      // 优先流式；不支持 stream 的模型回退为 chat 包装成生成器
      const generate = (): AsyncGenerator<ModelStreamEvent> => {
        const messages = buildMessages();
        const opts = { temperature: 0, maxTokens: ctx.config.maxOutputTokens };
        if (ctx.model.stream) {
          return ctx.model.stream(messages, opts);
        }
        return (async function* () {
          const text = await ctx.model.chat(messages, opts);
          yield { type: "text_delta" as const, text };
          yield { type: "done" as const, raw: text };
        })();
      };

      const turn = await runTurn({
        history,
        generate,
        parser: this.parser,
        knownTools: ctx.registry.names(),
        executor: this.executor,
        ctx,
        parseRetry: ctx.config.parseRetry,
        onEvent: (e) => this.emit(e),
      });

      if (turn.action === null) {
        task.status = "failed";
        trace.push({
          index: steps,
          action: {
            type: "final_answer",
            thought: "解析失败",
            answer: turn.finalAnswerText ?? "",
          },
          rawOutput: turn.raw,
          timestamp: Date.now(),
        });
        break;
      }

      const action = turn.action;
      if (action.type === "final_answer") {
        task.status = "done";
        completedTasks.push({ description: task.description, result: action.answer });
        trace.push({ index: steps, action, rawOutput: turn.raw, timestamp: Date.now() });
        this.emit({ type: "final_answer", answer: action.answer });
        if (this.scheduler.isEmpty()) {
          return { answer: action.answer, steps, history, taskTrace: trace };
        }
        currentTask = undefined;
        continue;
      }

      trace.push({
        index: steps,
        action,
        observation: turn.observation,
        rawOutput: turn.raw,
        timestamp: Date.now(),
      });
      steps += 1;
    }

    const answer = "达到最大步数或任务队列为空，任务未完成。";
    this.emit({ type: "max_turns_reached" });
    return { answer, steps, history, taskTrace: trace };
  }
  private recentFiles(ctx: AgentContext): string[] {
    return [ctx.workingMemory.lastReadFile, ctx.workingMemory.lastWrittenFile].filter(
      (file): file is string => typeof file === "string",
    );
  }
}

