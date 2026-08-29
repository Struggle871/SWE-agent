// 流式工具执行器：读工具可并行、写工具独占（对齐 Claude Code StreamingToolExecutor 的并发控制）。
// 当前 JSON 协议下模型每步只输出一个工具调用，此处先落地并发安全判定与队列结构，
// 为后续多工具流式并行执行预留。

import { randomUUID } from "node:crypto";
import type { AgentAction, AgentContext, ToolResult } from "../types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { Executor } from "./executor.js";

type ToolCallAction = Extract<AgentAction, { type: "tool_call" }>;

interface QueuedTool {
  id: string;
  action: ToolCallAction;
  status: "queued" | "executing" | "completed";
  isConcurrencySafe: boolean;
  result?: ToolResult;
}

export class StreamingToolExecutor {
  private queue: QueuedTool[] = [];

  constructor(
    private ctx: AgentContext,
    private registry: ToolRegistry,
    private executor: Executor,
  ) {}

  addTool(action: ToolCallAction): void {
    this.queue.push({
      id: randomUUID(),
      action,
      status: "queued",
      isConcurrencySafe: this.registry.isReadOnly(action.toolName),
    });
    void this.processQueue();
  }

  // 并发控制：读操作可与其它读操作并行；写操作独占执行
  private canExecute(t: QueuedTool, executing: QueuedTool[]): boolean {
    return (
      executing.length === 0 ||
      (t.isConcurrencySafe && executing.every((e) => e.isConcurrencySafe))
    );
  }

  private async processQueue(): Promise<void> {
    while (this.queue.some((t) => t.status !== "completed")) {
      const executing = this.queue.filter((t) => t.status === "executing");
      let started = false;
      for (const t of this.queue) {
        if (t.status !== "queued" || !this.canExecute(t, executing)) continue;
        t.status = "executing";
        started = true;
        this.executor
          .execute(t.action, this.ctx)
          .then((r) => {
            t.result = r;
            t.status = "completed";
          })
          .catch((e) => {
            t.result = {
              toolName: t.action.toolName,
              output: `工具执行异常: ${String(e)}`,
              isError: true,
            };
            t.status = "completed";
          });
        break; // 每轮只启动一个，避免饿死
      }
      if (!started && this.queue.every((t) => t.status === "completed")) break;
      if (!started) break; // 防止忙等：无可启动且未全部完成时跳出
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  async collect(): Promise<ToolResult[]> {
    // 等待所有任务完成（按提交顺序返回）
    while (this.queue.some((t) => t.status !== "completed")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.queue.map((t) => t.result ?? { toolName: t.action.toolName, output: "", isError: true });
  }

  get pendingCount(): number {
    return this.queue.filter((t) => t.status !== "completed").length;
  }
}
