import { randomUUID } from "node:crypto";
import type { ModelClient, Task } from "../types.js";

export class TaskPlanner {
  constructor(
    private model: ModelClient,
    private useLlmPlanning = false,
  ) {}

  async plan(userRequest: string): Promise<Task[]> {
    if (!this.useLlmPlanning) {
      return [makeTask(userRequest)];
    }

    try {
      const raw = await this.model.chat([
        {
          role: "system",
          content: '把下面的软件工程任务拆分成 3-6 个可执行的子任务。只输出一个 JSON 数组，每项形如 {"description": "..."}。',
        },
        { role: "user", content: userRequest },
      ]);
      const arr = JSON.parse(extractJsonArray(raw)) as unknown[];
      const tasks = arr.filter(isTaskDescription).map((x) => makeTask(x.description));
      return tasks.length > 0 ? tasks : [makeTask(userRequest)];
    } catch {
      return [makeTask(userRequest)];
    }
  }
}

function isTaskDescription(x: unknown): x is { description: string } {
  return typeof x === "object" && x !== null && typeof (x as { description?: unknown }).description === "string";
}

function makeTask(description: string): Task {
  return { id: randomUUID(), description, status: "pending" };
}

function extractJsonArray(text: string): string {
  const t = text.trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return "[]";
  return t.slice(start, end + 1);
}