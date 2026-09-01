import type { Tool, ToolRegistration, ToolRuntime, ToolSpec } from "./types.js";
import type { JsonSchema, JsonSchemaProperty } from "../types.js";

export class ToolConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolConfigurationError";
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  register(tool: Tool): void {
    const { execute: _execute, ...spec } = tool;
    this.registerDefinition({
      spec,
      runtime: { execute: (input, ctx, options) => tool.execute(input, ctx, options) },
      source: "legacy-tool",
    });
  }

  registerDefinition(registration: ToolRegistration): void {
    validateToolSpec(registration.spec);
    const key = qualifiedName(registration.spec);
    if (this.tools.has(key)) throw new ToolConfigurationError(`工具名称冲突: ${key}`);
    this.tools.set(key, registration);
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name)?.spec;
  }

  getSpec(name: string): ToolSpec | undefined {
    return this.tools.get(name)?.spec;
  }

  getRuntime(name: string): ToolRuntime | undefined {
    return this.tools.get(name)?.runtime;
  }

  getRegistration(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].map((registration) => registration.spec);
  }

  visibleSpecs(): ToolSpec[] {
    return this.list().filter((spec) => (spec.exposure ?? "direct") === "direct");
  }

  names(): Set<string> {
    return new Set(this.tools.keys());
  }

  /** 工具是否为只读（用于流式执行的并发安全判定） */
  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.spec.isReadOnly ?? false;
  }

  isParallelizable(name: string): boolean {
    const spec = this.tools.get(name)?.spec;
    return spec?.parallelizable ?? spec?.isReadOnly ?? false;
  }
}

export function qualifiedName(spec: Pick<ToolSpec, "name" | "namespace">): string {
  return spec.namespace ? `${spec.namespace}.${spec.name}` : spec.name;
}

export function validateToolInput(schema: JsonSchema, input: Record<string, unknown>): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ToolInputValidationError("$", "必须是对象");
  const normalized: Record<string, unknown> = { ...input };
  for (const name of schema.required ?? []) {
    if (!(name in normalized) || normalized[name] === undefined || normalized[name] === null) {
      throw new ToolInputValidationError(`$.${name}`, "缺少必填参数");
    }
  }
  for (const [name, value] of Object.entries(normalized)) {
    const property = schema.properties?.[name];
    if (!property && schema.additionalProperties !== true) throw new ToolInputValidationError(`$.${name}`, "未知参数");
    if (property) validateProperty(property, value, `$.${name}`);
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (!(name in normalized) && property.default !== undefined) normalized[name] = property.default;
  }
  return normalized;
}

export class ToolInputValidationError extends Error {
  constructor(public readonly fieldPath: string, reason: string) {
    super(`参数 ${fieldPath}${reason ? ` ${reason}` : ""}`);
    this.name = "ToolInputValidationError";
  }
}

function validateProperty(property: JsonSchemaProperty, value: unknown, fieldPath: string): void {
  if (value === undefined || value === null) return;
  const valid = property.type === "string" ? typeof value === "string"
    : property.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : property.type === "boolean" ? typeof value === "boolean"
        : property.type === "array" ? Array.isArray(value)
          : property.type === "object" ? typeof value === "object" && !Array.isArray(value)
            : true;
  if (!valid) throw new ToolInputValidationError(fieldPath, `类型错误，期望 ${property.type}`);
  if (property.enum && typeof value === "string" && !property.enum.includes(value)) {
    throw new ToolInputValidationError(fieldPath, `值不在允许范围内: ${property.enum.join(", ")}`);
  }
  if (property.items && Array.isArray(value)) value.forEach((item, index) => validateProperty(property.items!, item, `${fieldPath}[${index}]`));
}

function validateToolSpec(spec: ToolSpec): void {
  if (!spec.name || !/^[A-Za-z0-9._-]+$/.test(spec.name)) throw new ToolConfigurationError(`工具名称非法: ${spec.name}`);
  if (spec.namespace && !/^[A-Za-z0-9._-]+$/.test(spec.namespace)) throw new ToolConfigurationError(`工具 namespace 非法: ${spec.namespace}`);
  if (!spec.description.trim()) throw new ToolConfigurationError(`工具 ${qualifiedName(spec)} 缺少 description`);
  validateSchema(spec.parameters, `tool ${qualifiedName(spec)}`);
}

function validateSchema(schema: JsonSchema, owner: string): void {
  if (!schema || schema.type !== "object") throw new ToolConfigurationError(`${owner} schema 顶层必须是 object`);
  const properties = schema.properties ?? {};
  for (const required of schema.required ?? []) {
    if (!(required in properties)) throw new ToolConfigurationError(`${owner} required 字段不存在: ${required}`);
  }
  for (const [name, property] of Object.entries(properties)) {
    if (!property || typeof property.type !== "string") throw new ToolConfigurationError(`${owner} 字段 ${name} 缺少有效 type`);
    if (property.items && property.type !== "array") throw new ToolConfigurationError(`${owner} 字段 ${name} 只有 array 可以声明 items`);
  }
}
