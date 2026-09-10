import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../types.js";
import type { SessionId } from "../protocol/ids.js";

export interface TaskGraphSnapshot {
  schemaVersion: 1;
  revision: number;
  tasks: Task[];
}
export interface TaskGraphEvent { operation: "create" | "update" | "claim" | "complete" | "fail" | "cancel"; task: Task }

/** Durable DAG store. Mutations are synchronously committed through an atomic rename. */
export class TaskGraphStore {
  private readonly tasksById = new Map<string, Task>();
  private revision = 0;
  private loaded = false;

  constructor(private readonly filePath?: string, private readonly onChange?: (event: TaskGraphEvent) => void | Promise<void>) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, "utf8")) as Partial<TaskGraphSnapshot>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) throw new Error("task graph schema 无效");
      this.revision = Number.isInteger(parsed.revision) ? parsed.revision! : 0;
      for (const task of parsed.tasks) this.tasksById.set(task.id, clone(task));
      for (const task of parsed.tasks) this.validateAndSet(task);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`任务图读取失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  list(): Task[] {
    return [...this.tasksById.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id)).map(clone);
  }

  get(id: string): Task | undefined {
    const task = this.tasksById.get(id);
    return task ? clone(task) : undefined;
  }

  create(input: Omit<Task, "id" | "status" | "createdAt" | "updatedAt" | "attempts"> & { id?: string; status?: Task["status"] }): Task {
    const now = Date.now();
    const task: Task = {
      ...input,
      id: input.id ?? randomUUID(),
      status: input.status ?? "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      dependsOn: input.dependsOn ? [...input.dependsOn] : [],
      acceptanceCriteria: input.acceptanceCriteria ? [...input.acceptanceCriteria] : [],
    };
    if (this.tasksById.has(task.id)) throw new Error(`任务已存在: ${task.id}`);
    this.validateAndSet(task);
    try { this.commit(); } catch (error) { this.tasksById.delete(task.id); throw error; }
    void this.onChange?.({ operation: "create", task: clone(task) });
    return clone(task);
  }

  update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Task {
    return this.applyUpdate(id, patch, "update");
  }

  private applyUpdate(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>, operation: TaskGraphEvent["operation"]): Task {
    const current = this.tasksById.get(id);
    if (!current) throw new Error(`任务不存在: ${id}`);
    const next = { ...current, ...patch, id, updatedAt: Date.now() } as Task;
    this.validateAndSet(next);
    try { this.commit(); } catch (error) { this.tasksById.set(id, current); throw error; }
    void this.onChange?.({ operation, task: clone(next) });
    return clone(next);
  }

  claimReady(ownerSessionId: SessionId): Task | undefined {
    const candidate = this.list().find((task) => this.isReady(task));
    if (!candidate) return undefined;
    return this.applyUpdate(candidate.id, { status: "in_progress", ownerSessionId, attempts: (candidate.attempts ?? 0) + 1 }, "claim");
  }

  complete(id: string, resultSummary?: string): Task {
    return this.applyUpdate(id, { status: "completed", resultSummary }, "complete");
  }

  fail(id: string, reason: string): Task {
    const current = this.tasksById.get(id);
    if (!current) throw new Error(`任务不存在: ${id}`);
    const attempts = current.attempts ?? 0;
    const maxAttempts = current.maxAttempts ?? 1;
    return this.applyUpdate(id, { status: attempts < maxAttempts ? "retrying" : "failed", resultSummary: reason }, "fail");
  }

  cancel(id: string, reason = "cancelled"): Task {
    const current = this.tasksById.get(id);
    if (!current) throw new Error(`任务不存在: ${id}`);
    const previous = new Map([...this.tasksById].map(([taskId, task]) => [taskId, clone(task)]));
    const queue: Array<{ id: string; reason: string }> = [{ id, reason }];
    while (queue.length > 0) {
      const item = queue.shift()!;
      const task = this.tasksById.get(item.id);
      if (!task) continue;
      this.tasksById.set(item.id, { ...task, status: "cancelled", resultSummary: item.reason, updatedAt: Date.now() });
      for (const dependent of this.tasksById.values()) {
        if (dependent.dependsOn?.includes(item.id) && ["pending", "blocked", "retrying"].includes(dependent.status)) {
          queue.push({ id: dependent.id, reason: `依赖任务 ${item.id} 已取消` });
        }
      }
    }
    try { this.commit(); } catch (error) { this.tasksById.clear(); for (const [taskId, task] of previous) this.tasksById.set(taskId, task); throw error; }
    const result = clone(this.tasksById.get(id)!);
    void this.onChange?.({ operation: "cancel", task: result });
    return result;
  }

  isReady(task: Task): boolean {
    if (!["pending", "blocked", "retrying"].includes(task.status)) return false;
    return (task.dependsOn ?? []).every((id) => this.tasksById.get(id)?.status === "completed" || this.tasksById.get(id)?.status === "done");
  }

  private validateAndSet(task: Task): void {
    if (!task.id || !task.description.trim()) throw new Error("任务必须包含 id 和 description");
    const dependencies = task.dependsOn ?? [];
    if (dependencies.includes(task.id)) throw new Error(`任务不能依赖自身: ${task.id}`);
    for (const dependency of dependencies) if (dependency !== task.id && !this.tasksById.has(dependency)) {
      throw new Error(`任务依赖不存在: ${dependency}`);
    }
    const previous = this.tasksById.get(task.id);
    this.tasksById.set(task.id, clone(task));
    if (this.hasCycle()) {
      if (previous) this.tasksById.set(task.id, previous); else this.tasksById.delete(task.id);
      throw new Error(`任务图存在循环依赖: ${task.id}`);
    }
  }

  private hasCycle(): boolean {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const dependency of this.tasksById.get(id)?.dependsOn ?? []) if (this.tasksById.has(dependency) && visit(dependency)) return true;
      visiting.delete(id); visited.add(id); return false;
    };
    return [...this.tasksById.keys()].some(visit);
  }

  private commit(): void {
    if (!this.filePath) return;
    const nextRevision = this.revision + 1;
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    let lock: number | undefined;
    try {
      try { lock = fs.openSync(lockPath, "wx"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (age > 30_000) { fs.unlinkSync(lockPath); lock = fs.openSync(lockPath, "wx"); }
          else throw new Error("任务图正被其他进程修改，请稍后重试");
        } else throw error;
      }
      const diskRevision = readRevision(this.filePath);
      if (diskRevision !== undefined && diskRevision !== this.revision) throw new Error(`任务图 revision 冲突: 本地 ${this.revision}，磁盘 ${diskRevision}`);
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      const payload: TaskGraphSnapshot = { schemaVersion: 1, revision: nextRevision, tasks: this.list() };
      fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { encoding: "utf8", flag: "wx" });
      fs.renameSync(temp, this.filePath);
      this.revision = nextRevision;
    } finally {
      if (lock !== undefined) fs.closeSync(lock);
      try { fs.unlinkSync(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
function readRevision(filePath: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<TaskGraphSnapshot>;
    return Number.isInteger(parsed.revision) ? parsed.revision : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
