import { randomUUID } from "node:crypto";
import type { AgentAction, AgentContext, ToolResult } from "../types.js";
import { Executor } from "./executor.js";

type ToolCallAction = Extract<AgentAction, { type: "tool_call" }>;
type QueueStatus = "queued" | "executing" | "completed";

interface QueuedTool {
  id: string;
  action: ToolCallAction;
  status: QueueStatus;
  isReadOnly: boolean;
  result?: ToolResult;
}

/** Promise-driven read/write gate. Results remain in submission order. */
export class StreamingToolExecutor {
  private readonly queue: QueuedTool[] = [];
  private active = 0;
  private activeReads = 0;
  private wake: (() => void) | undefined;
  private scheduling = false;

  constructor(private readonly ctx: AgentContext, private readonly executor = new Executor()) {}

  addTool(action: ToolCallAction): void {
    const spec = this.ctx.registry.getSpec(action.toolName);
    this.queue.push({ id: randomUUID(), action, status: "queued", isReadOnly: spec?.isReadOnly === true && spec.parallelizable !== false });
    this.schedule();
  }

  async collect(): Promise<ToolResult[]> {
    while (this.queue.some((task) => task.status !== "completed")) {
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.schedule();
    }
    return this.queue.map((task) => task.result ?? { toolName: task.action.toolName, output: "", isError: true });
  }

  get pendingCount(): number { return this.queue.filter((task) => task.status !== "completed").length; }

  private schedule(): void {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      while (true) {
        const next = this.queue.find((task) => task.status === "queued" && this.canStart(task));
        if (!next) break;
        next.status = "executing";
        this.active += 1;
        if (next.isReadOnly) this.activeReads += 1;
        void this.execute(next);
      }
    } finally {
      this.scheduling = false;
    }
  }

  private canStart(task: QueuedTool): boolean {
    return task.isReadOnly ? this.active === this.activeReads : this.active === 0;
  }

  private async execute(task: QueuedTool): Promise<void> {
    try {
      task.result = await this.executor.execute(task.action, this.ctx);
    } catch (error) {
      task.result = { toolName: task.action.toolName, output: `工具执行异常: ${String(error)}`, isError: true };
    } finally {
      task.status = "completed";
      this.active -= 1;
      if (task.isReadOnly) this.activeReads -= 1;
      const wake = this.wake;
      this.wake = undefined;
      wake?.();
      this.schedule();
    }
  }
}
