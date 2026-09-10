import type { Task } from "../types.js";
import { TaskGraphStore } from "./task-graph.js";
import type { SessionId } from "../protocol/ids.js";

export class TaskScheduler {
  constructor(private readonly graph = new TaskGraphStore()) {}

  push(tasks: Task[]): void {
    for (const task of tasks) {
      const { id, status: _status, createdAt: _createdAt, updatedAt: _updatedAt, attempts: _attempts, ...input } = task;
      this.graph.create({ ...input, ...(id ? { id } : {}) });
    }
  }

  next(ownerSessionId: SessionId): Task | undefined {
    return this.graph.claimReady(ownerSessionId);
  }

  isEmpty(): boolean {
    return !this.graph.list().some((task) => this.graph.isReady(task) || task.status === "in_progress");
  }

  get taskGraph(): TaskGraphStore { return this.graph; }
}
