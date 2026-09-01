import type { AgentContext, JsonSchema, ToolResult } from "../types.js";

export type ToolExposure = "direct" | "deferred" | "internal" | "hidden";

export interface SandboxRequirements {
  filesystem?: "workspace" | "unrestricted";
  network?: boolean;
  subprocess?: boolean;
  workingDirectory?: boolean;
  environment?: "filtered" | "unrestricted";
  timeout?: boolean;
  cancellation?: boolean;
}

export interface ToolSpec {
  name: string;
  namespace?: string;
  description: string;
  parameters: JsonSchema;
  isReadOnly?: boolean;
  exposure?: ToolExposure;
  parallelizable?: boolean;
  sandbox?: SandboxRequirements;
}

export interface RuntimeExecuteOptions {
  signal?: AbortSignal;
}

export interface ToolRuntime {
  execute(input: Record<string, unknown>, ctx: AgentContext, options?: RuntimeExecuteOptions): Promise<ToolResult>;
}

export interface ToolRegistration {
  spec: ToolSpec;
  runtime: ToolRuntime;
  source?: string;
  version?: string;
}

export interface Tool extends ToolSpec {
  /** M0/M1 legacy runtime entry point; registry wraps it as ToolRuntime. */
  execute(input: Record<string, unknown>, ctx: AgentContext, options?: RuntimeExecuteOptions): Promise<ToolResult>;
}
