import type { AgentAction, AgentContext, AgentRunResult, AgentStep, CompletedTaskSummary, Message, Task } from "../types.js";
import { Executor } from "./executor.js";
import { OutputParser } from "./output-parser.js";
import { PromptBuilder } from "./prompt-builder.js";
import { TaskPlanner } from "./task-planner.js";
import { TaskScheduler } from "./task-scheduler.js";

export class Agent {
  private scheduler = new TaskScheduler();
  private promptBuilder = new PromptBuilder();
  private parser = new OutputParser();
  private executor = new Executor();
  private planner: TaskPlanner;

  constructor(private ctx: AgentContext) {
    this.planner = new TaskPlanner(ctx.model, ctx.config.useLlmPlanning);
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

      const callModel = () =>
        ctx.model.chat(
          this.promptBuilder.build({
            messages: history,
            currentTask: task,
            completedTasks,
            workingMemory: ctx.workingMemory,
            tools: ctx.registry.list(),
            config: ctx.config,
          }),
          { temperature: 0, maxTokens: ctx.config.maxOutputTokens },
        );

      let raw = await callModel();
      let action: AgentAction | null = null;
      try {
        action = this.parser.parse(raw, ctx.registry.names());
      } catch {
        action = null;
      }

      if (action === null) {
        history.push({ role: "assistant", content: raw });
        for (let i = 0; i < ctx.config.parseRetry && action === null; i++) {
          history.push({
            role: "tool",
            name: "parser",
            content: "解析失败：请严格按约定只输出一个 JSON 对象（thought / action / action_input）。",
          });
          raw = await callModel();
          history.push({ role: "assistant", content: raw });
          try {
            action = this.parser.parse(raw, ctx.registry.names());
          } catch {
            action = null;
          }
        }
        if (action === null) {
          task.status = "failed";
          trace.push({
            index: steps,
            action: { type: "final_answer", thought: "解析失败", answer: "连续解析失败，终止任务。" },
            rawOutput: raw,
            timestamp: Date.now(),
          });
          break;
        }
      } else {
        history.push({ role: "assistant", content: raw });
      }

      if (action.type === "final_answer") {
        task.status = "done";
        completedTasks.push({ description: task.description, result: action.answer });
        trace.push({ index: steps, action, rawOutput: raw, timestamp: Date.now() });
        if (this.scheduler.isEmpty()) {
          return { answer: action.answer, steps, history, taskTrace: trace };
        }
        currentTask = undefined;
        continue;
      }

      const observation = await this.executor.execute(action, ctx);
      history.push({ role: "tool", name: action.toolName, content: observation.output });
      trace.push({ index: steps, action, observation, rawOutput: raw, timestamp: Date.now() });
      steps += 1;
    }

    return {
      answer: "达到最大步数或任务队列为空，任务未完成。",
      steps,
      history,
      taskTrace: trace,
    };
  }
}