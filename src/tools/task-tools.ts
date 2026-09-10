import type { Tool } from "./types.js";
import type { JsonSchemaProperty } from "../types.js";

const taskProperties: Record<string, JsonSchemaProperty> = {
  id: { type: "string", description: "任务 id" },
  description: { type: "string", description: "任务描述" },
  dependsOn: { type: "array", items: { type: "string" }, description: "前置任务 id" },
  acceptanceCriteria: { type: "array", items: { type: "string" } },
  maxAttempts: { type: "number" },
  resultSummary: { type: "string" },
  status: { type: "string", enum: ["pending", "blocked", "in_progress", "completed", "failed", "retrying", "cancelled"] },
};

export const taskCreateTool: Tool = {
  name: "task_create",
  description: "在持久化任务 DAG 中创建一个任务。dependsOn 必须引用已存在任务。",
  parameters: { type: "object", properties: { description: taskProperties.description, dependsOn: taskProperties.dependsOn, acceptanceCriteria: taskProperties.acceptanceCriteria, maxAttempts: taskProperties.maxAttempts }, required: ["description"], additionalProperties: false },
  isReadOnly: false,
  async execute(input, ctx) {
    if (!ctx.taskGraph) return { toolName: "task_create", output: "任务图未启用", isError: true };
    try { return { toolName: "task_create", output: JSON.stringify(ctx.taskGraph.create({ description: String(input.description), dependsOn: arrayOfStrings(input.dependsOn), acceptanceCriteria: arrayOfStrings(input.acceptanceCriteria), maxAttempts: numberOr(input.maxAttempts, 1) })) }; }
    catch (error) { return { toolName: "task_create", output: errorText(error), isError: true }; }
  },
};

export const taskListTool: Tool = {
  name: "task_list",
  description: "列出当前会话任务 DAG 及其依赖、状态和结果摘要。",
  parameters: { type: "object", properties: { status: taskProperties.status }, additionalProperties: false },
  isReadOnly: true,
  async execute(input, ctx) {
    const tasks = ctx.taskGraph?.list() ?? [];
    const status = typeof input.status === "string" ? input.status : undefined;
    return { toolName: "task_list", output: JSON.stringify(status ? tasks.filter((task) => task.status === status) : tasks) };
  },
};

export const taskGetTool: Tool = {
  name: "task_get",
  description: "按 id 查询任务。",
  parameters: { type: "object", properties: { id: taskProperties.id }, required: ["id"], additionalProperties: false },
  isReadOnly: true,
  async execute(input, ctx) {
    const task = ctx.taskGraph?.get(String(input.id));
    return task ? { toolName: "task_get", output: JSON.stringify(task) } : { toolName: "task_get", output: "任务不存在", isError: true };
  },
};

export const taskUpdateTool: Tool = {
  name: "task_update",
  description: "更新任务状态、依赖或结果；取消会传播到下游未完成任务。",
  parameters: { type: "object", properties: taskProperties, required: ["id"], additionalProperties: false },
  isReadOnly: false,
  async execute(input, ctx) {
    if (!ctx.taskGraph) return { toolName: "task_update", output: "任务图未启用", isError: true };
    try {
      const id = String(input.id);
      const status = typeof input.status === "string" ? input.status as never : undefined;
      const result = status === "cancelled" ? ctx.taskGraph.cancel(id, typeof input.resultSummary === "string" ? input.resultSummary : undefined) : ctx.taskGraph.update(id, {
        ...(status ? { status } : {}),
        ...(typeof input.description === "string" ? { description: input.description } : {}),
        ...(typeof input.resultSummary === "string" ? { resultSummary: input.resultSummary } : {}),
        ...(input.dependsOn !== undefined ? { dependsOn: arrayOfStrings(input.dependsOn) } : {}),
        ...(input.acceptanceCriteria !== undefined ? { acceptanceCriteria: arrayOfStrings(input.acceptanceCriteria) } : {}),
        ...(typeof input.maxAttempts === "number" ? { maxAttempts: numberOr(input.maxAttempts, 1) } : {}),
      });
      return { toolName: "task_update", output: JSON.stringify(result) };
    } catch (error) { return { toolName: "task_update", output: errorText(error), isError: true }; }
  },
};

function arrayOfStrings(value: unknown): string[] | undefined { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined; }
function numberOr(value: unknown, fallback: number): number { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
