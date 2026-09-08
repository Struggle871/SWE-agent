import { createHash } from "node:crypto";
import type { ModelToolDefinition } from "../protocol/model-events.js";
import type { ToolRegistry } from "./registry.js";
import { qualifiedName } from "./registry.js";
import type { ToolSpec } from "./types.js";

export interface PlannedTool {
  name: string;
  spec: ToolSpec;
  isReadOnly: boolean;
  parallelizable: boolean;
}

/** Immutable per-turn view of tools exposed to the model and compaction backends. */
export interface SpecPlan {
  tools: readonly PlannedTool[];
  definitions: readonly ModelToolDefinition[];
  names: ReadonlySet<string>;
  fingerprint: string;
}

export function buildSpecPlan(registry: ToolRegistry): SpecPlan {
  const tools = registry.visibleSpecs().map((spec) => ({
    name: qualifiedName(spec),
    spec: structuredClone(spec),
    isReadOnly: spec.isReadOnly ?? false,
    parallelizable: spec.parallelizable ?? spec.isReadOnly ?? false,
  }));
  const definitions = tools.map((tool) => ({ name: tool.name, description: tool.spec.description, parameters: tool.spec.parameters }));
  const fingerprint = createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
  return { tools, definitions, names: new Set(tools.map((tool) => tool.name)), fingerprint };
}
