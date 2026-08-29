import type { Task } from "../types.js";

export class TaskScheduler {
  private stack: Task[] = [];

  push(tasks: Task[]): void {
    for (let i = tasks.length - 1; i >= 0; i--) {
      this.stack.push(tasks[i]);
    }
  }

  next(): Task | undefined {
    const task = this.stack.pop();
    if (task) task.status = "in_progress";
    return task;
  }

  isEmpty(): boolean {
    return this.stack.length === 0;
  }
}