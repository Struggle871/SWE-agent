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
  private generation = 0;
  private readonly activeLeases = new Map<ToolRegistration, number>();
  private readonly drainWaiters = new Map<ToolRegistration, Set<() => void>>();

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
    this.generation += 1;
  }

  replaceSources(sourcePrefixes: readonly string[], registrations: readonly ToolRegistration[]): number {
    return this.replaceSourcesWithDrain(sourcePrefixes, registrations).generation;
  }

  replaceSourcesWithDrain(sourcePrefixes: readonly string[], registrations: readonly ToolRegistration[]): { generation: number; drained: Promise<void> } {
    const retired = [...this.tools.values()].filter((registration) => sourcePrefixes.some((prefix) => (registration.source ?? "").startsWith(prefix)));
    const next = new Map([...this.tools].filter(([, registration]) => !sourcePrefixes.some((prefix) => (registration.source ?? "").startsWith(prefix))));
    for (const registration of registrations) {
      validateToolSpec(registration.spec);
      const key = qualifiedName(registration.spec);
      if (next.has(key)) throw new ToolConfigurationError(`工具名称冲突: ${key}`);
      next.set(key, registration);
    }
    this.tools = next;
    return { generation: ++this.generation, drained: Promise.all(retired.map((registration) => this.waitUntilDrained(registration))).then(() => undefined) };
  }

  acquireRegistration(name: string): { registration: ToolRegistration; release: () => void } | undefined {
    const registration = this.resolve(name);
    if (!registration) return undefined;
    this.activeLeases.set(registration, (this.activeLeases.get(registration) ?? 0) + 1);
    let released = false;
    return { registration, release: () => {
      if (released) return;
      released = true;
      const remaining = (this.activeLeases.get(registration) ?? 1) - 1;
      if (remaining > 0) this.activeLeases.set(registration, remaining);
      else {
        this.activeLeases.delete(registration);
        for (const resolve of this.drainWaiters.get(registration) ?? []) resolve();
        this.drainWaiters.delete(registration);
      }
    } };
  }

  get currentGeneration(): number { return this.generation; }

  get(name: string): ToolSpec | undefined {
    return this.resolve(name)?.spec;
  }

  getSpec(name: string): ToolSpec | undefined {
    return this.resolve(name)?.spec;
  }

  getRuntime(name: string): ToolRuntime | undefined {
    return this.resolve(name)?.runtime;
  }

  getRegistration(name: string): ToolRegistration | undefined {
    return this.resolve(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()].map((registration) => registration.spec);
  }

  status(): Array<{ name: string; namespace?: string; source: string; exposure: string; readOnly: boolean }> {
    return [...this.tools.values()].map((registration) => ({
      name: qualifiedName(registration.spec),
      ...(registration.spec.namespace ? { namespace: registration.spec.namespace } : {}),
      source: registration.source ?? "unknown",
      exposure: registration.spec.exposure ?? "direct",
      readOnly: registration.spec.isReadOnly === true,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  visibleSpecs(): ToolSpec[] {
    return this.list().filter((spec) => (spec.exposure ?? "direct") === "direct");
  }

  names(): Set<string> {
    return new Set(this.tools.keys());
  }

  /** 工具是否为只读（用于流式执行的并发安全判定） */
  isReadOnly(name: string): boolean {
    return this.resolve(name)?.spec.isReadOnly ?? false;
  }

  isParallelizable(name: string): boolean {
    const spec = this.resolve(name)?.spec;
    return spec?.parallelizable ?? spec?.isReadOnly ?? false;
  }

  private resolve(name: string): ToolRegistration | undefined {
    const exact = this.tools.get(name);
    if (exact || name.includes(".")) return exact;
    const matches = [...this.tools.entries()].filter(([key]) => key.endsWith(`.${name}`));
    return matches.length === 1 ? matches[0][1] : undefined;
  }

  private waitUntilDrained(registration: ToolRegistration): Promise<void> {
    if ((this.activeLeases.get(registration) ?? 0) === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.drainWaiters.get(registration) ?? new Set<() => void>();
      waiters.add(resolve);
      this.drainWaiters.set(registration, waiters);
    });
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
