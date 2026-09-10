import type { CompletedTaskSummary, AgentContext, Task } from "../../types.js";
import type { ToolSpec } from "../../tools/types.js";
import type { ReferenceContextPayload, WorldStatePayload } from "./compaction-types.js";
import { fingerprint, stableStringify } from "./token-accounting.js";

export interface WorldStateInput {
  ctx: AgentContext;
  tools: readonly ToolSpec[];
  task?: Task;
  completedTasks?: readonly CompletedTaskSummary[];
}

export function buildWorldState(input: WorldStateInput): WorldStatePayload {
  const instructionEntries = input.ctx.instructionSnapshot?.entries.map((entry) => ({
    id: entry.id,
    sourcePath: entry.sourcePath,
    content: entry.content,
    byteLength: entry.byteLength,
    truncated: entry.truncated,
    contentHash: entry.contentHash,
  }));
  const catalogFragments = input.ctx.contextualFragments?.filter((fragment) => fragment.type === "skills.catalog") ?? [];
  const state: Record<string, unknown> = {
    model: input.ctx.config.model.model,
    contextLimit: input.ctx.config.maxContextTokens,
    cwd: input.ctx.workspaceRoot,
    readableRoots: input.ctx.workspacePolicy.readableRoots,
    writableRoots: input.ctx.workspacePolicy.writableRoots,
    permission: input.ctx.permissionPolicy.profile,
    tools: input.tools.map((tool) => ({
      name: tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name,
      description: tool.description,
      parameters: tool.parameters,
      exposure: tool.exposure ?? "direct",
    })),
    config: {
      effectiveFingerprint: input.ctx.configStack?.fingerprint ?? input.ctx.config.configFingerprint ?? "",
      requirementsFingerprint: input.ctx.configStack?.requirements.fingerprint ?? input.ctx.config.requirementsFingerprint ?? "",
    },
    instructions: input.ctx.instructionSnapshot ? {
      fingerprint: input.ctx.instructionSnapshot.fingerprint,
      totalBytes: input.ctx.instructionSnapshot.totalBytes,
      entries: instructionEntries,
      ...(input.ctx.agentMemories ? { legacy: input.ctx.agentMemories } : {}),
    } : input.ctx.contextualFragments?.filter((fragment) => fragment.type.startsWith("agents_md.")).map((fragment) => fragment.text).join("\n\n") ?? input.ctx.agentMemories ?? "",
    workingMemory: input.ctx.workingMemory,
    currentTask: input.task ? { id: input.task.id, description: input.task.description } : null,
    completedTasks: input.completedTasks ?? [],
    skills: {
      catalogFingerprint: input.ctx.skillSnapshot?.catalogFingerprint ?? fingerprint(catalogFragments.map((fragment) => fragment.hash)),
      catalog: catalogFragments.map((fragment) => ({ source: fragment.source, hash: fragment.hash, text: fragment.text })),
      selected: (input.ctx.selectedSkills ?? []).map(({ skillId, locator, name, body, bodyHash }) => ({ skillId, locator, name, body, bodyHash })),
    },
    mcp: { resources: [], tools: [] },
    memory: input.ctx.memoryStore ? { fingerprint: input.ctx.memoryStore.fingerprint() } : { fingerprint: "" },
    collaboration: { mode: "single_agent" },
  };
  return { full: true, state, fingerprint: fingerprint(state) };
}

export function referenceContext(world: WorldStatePayload, input: WorldStateInput, compHash: string): ReferenceContextPayload {
  const instructionFingerprint = fingerprint({
    snapshot: input.ctx.instructionSnapshot?.fingerprint
      ?? input.ctx.contextualFragments?.filter((fragment) => fragment.type.startsWith("agents_md.")).map((fragment) => fragment.hash),
    legacy: input.ctx.agentMemories ?? "",
  });
  const selectedSkillFingerprint = fingerprint((input.ctx.selectedSkills ?? []).map(({ skillId, locator, bodyHash }) => ({ skillId, locator, bodyHash })));
  return {
    cleared: false,
    model: input.ctx.config.model.model,
    compHash,
    contextLimit: input.ctx.config.maxContextTokens,
    cwd: input.ctx.workspaceRoot,
    instructionFingerprint,
    skillCatalogFingerprint: input.ctx.skillSnapshot?.catalogFingerprint ?? fingerprint([]),
    selectedSkillFingerprint,
    memoryFingerprint: input.ctx.memoryStore?.fingerprint() ?? "",
    configFingerprint: input.ctx.configStack?.fingerprint ?? input.ctx.config.configFingerprint,
    requirementsFingerprint: input.ctx.configStack?.requirements.fingerprint ?? input.ctx.config.requirementsFingerprint,
    toolLayoutFingerprint: fingerprint(input.tools),
    permissionFingerprint: input.ctx.permissionPolicy.fingerprint(),
    worldStateFingerprint: world.fingerprint,
  };
}

export function contextCompatibilityFingerprint(input: WorldStateInput): string {
  return fingerprint({
    schema: 2,
    model: input.ctx.config.model.model,
    config: input.ctx.configStack?.fingerprint ?? input.ctx.config.configFingerprint ?? "",
    requirements: input.ctx.configStack?.requirements.fingerprint ?? input.ctx.config.requirementsFingerprint ?? "",
    instructions: {
      snapshot: input.ctx.instructionSnapshot?.fingerprint
        ?? input.ctx.contextualFragments?.filter((fragment) => fragment.type.startsWith("agents_md.")).map((fragment) => fragment.hash),
      legacy: input.ctx.agentMemories ?? "",
    },
    skillCatalog: input.ctx.skillSnapshot?.catalogFingerprint ?? "",
    selectedSkills: (input.ctx.selectedSkills ?? []).map(({ skillId, bodyHash }) => ({ skillId, bodyHash })),
    memory: input.ctx.memoryStore?.fingerprint() ?? "",
    tools: input.tools,
    permissions: input.ctx.permissionPolicy.fingerprint(),
  });
}

export function clearedReferenceContext(): ReferenceContextPayload {
  return { cleared: true };
}

export function renderWorldState(world: WorldStatePayload): string {
  return `<environment_context>\n${stableStringify(world.state)}\n</environment_context>`;
}

export function worldStateDiff(previous: WorldStatePayload | undefined, current: WorldStatePayload, forceFull: boolean): WorldStatePayload | undefined {
  if (forceFull || !previous) return current;
  if (previous.fingerprint === current.fingerprint) return undefined;
  const patch = mergePatch(previous.state, current.state);
  return { full: false, state: patch, fingerprint: current.fingerprint };
}

export function applyWorldState(base: WorldStatePayload | undefined, update: WorldStatePayload): WorldStatePayload {
  if (update.full || !base) return { full: true, state: structuredClone(update.state), fingerprint: update.fingerprint };
  return { full: true, state: applyMergePatch(base.state, update.state), fingerprint: update.fingerprint };
}

function mergePatch(previous: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (!(key in current)) patch[key] = null;
    else if (!(key in previous) || stableStringify(previous[key]) !== stableStringify(current[key])) patch[key] = current[key];
  }
  return patch;
}

function applyMergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = structuredClone(value);
  }
  return next;
}
