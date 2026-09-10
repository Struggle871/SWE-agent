import { createHash } from "node:crypto";
import type { AgentContext } from "../types.js";
import { instructionFragments, loadInstructionSnapshot } from "./agents-md.js";
import { buildSkillContext, loadSkillContext, type SkillContext, type SkillMetadata } from "./skills.js";
import { SkillSelector, auditSkillContext } from "../skills/platform.js";
import { EmbeddingSkillSelector, OpenAIEmbeddingClient } from "../skills/semantic-selector.js";
import type { ConfigDiagnostic } from "./layered-config.js";

export interface ContextRefreshResult {
  diagnostics: readonly ConfigDiagnostic[];
  skillContext: SkillContext;
}

export async function refreshContextualFragments(ctx: AgentContext, selectedMentions: readonly string[] = [], query = ""): Promise<ContextRefreshResult> {
  const projectRoot = ctx.configStack?.projectRoot ?? ctx.workspaceRoot;
  const trusted = ctx.configStack?.projectTrusted ?? ctx.config.agents?.projectTrusted ?? true;
  const instructions = loadInstructionSnapshot({
    cwd: ctx.workspaceRoot,
    projectRoot,
    projectRootMarkers: ctx.config.agents?.projectRootMarkers,
    fallbackFilenames: ctx.config.agents?.fallbackFilenames,
    budgetBytes: ctx.config.agents?.maxBytes,
    trusted,
    fileSystem: ctx.contextFileSystem,
  });
  const skillOptions = {
    ...(ctx.config.skills ?? {}),
    projectRoot,
    trusted,
    maxCatalogTokens: ctx.config.skills?.maxContextTokens ?? Math.max(1, Math.floor(ctx.config.maxContextTokens * 0.02)),
    ...(ctx.skillTokenizer ? { tokenizer: ctx.skillTokenizer, model: ctx.config.model.model } : {}),
    fileSystem: ctx.contextFileSystem,
  };
  const localContext = ctx.skillPlatform
    ? { snapshot: Object.freeze({ skills: Object.freeze([]), roots: Object.freeze([]), fingerprint: "", catalogFingerprint: "", diagnostics: Object.freeze([]) }), selected: Object.freeze([]), fragments: Object.freeze([]), diagnostics: Object.freeze([]) } satisfies SkillContext
    : loadSkillContext(ctx.workspaceRoot, [], skillOptions);
  let snapshot = localContext.snapshot;
  const providerDiagnostics: ConfigDiagnostic[] = [];
  if (ctx.skillPlatform) {
    const providerSkills = await ctx.skillPlatform.listAudited(ctx);
    providerDiagnostics.push(...ctx.skillPlatform.diagnostics());
    const merged = [...localContext.snapshot.skills];
    for (const skill of providerSkills) {
      if (skill.providerId !== "local" || !merged.some((item) => item.id === skill.id)) merged.push(skill);
    }
    snapshot = Object.freeze({ ...ctx.skillPlatform.snapshot(localContext.snapshot), skills: Object.freeze(merged) });
  }
  const eligibilityDiagnostics: ConfigDiagnostic[] = [];
  const products = new Set(ctx.config.skills?.products ?? ["minimal-swe-agent"]);
  const availableTools = ctx.registry.names();
  const eligibleSkills = snapshot.skills.map((skill) => {
    const missing: string[] = [];
    if (skill.policy?.products.length && !skill.policy.products.some((product) => products.has(product))) missing.push(`product(${skill.policy.products.join("|")})`);
    for (const dependency of skill.dependencies ?? []) {
      if (dependency.type === "tool" && !availableTools.has(dependency.value) && ![...availableTools].some((name) => name.endsWith(`.${dependency.value}`))) missing.push(`tool(${dependency.value})`);
      if (dependency.type === "mcp" && !ctx.skillPlatform?.hasReadyProvider(dependency.value)) missing.push(`mcp(${dependency.value})`);
    }
    if (missing.length === 0) return skill;
    eligibilityDiagnostics.push({ severity: "warning", code: "skill_dependency_unavailable", message: `Skill ${skill.name} 不可用，缺少: ${missing.join(", ")}`, sourcePath: skill.path });
    return { ...skill, enabled: false };
  });
  snapshot = Object.freeze({ ...snapshot, skills: Object.freeze(eligibleSkills), fingerprint: createHash("sha256").update(`${snapshot.fingerprint}:${JSON.stringify(eligibleSkills.map((skill) => [skill.id, skill.enabled]))}`).digest("hex") });
  const selectionDiagnostics: ConfigDiagnostic[] = [];
  let effectiveMentions = selectedMentions;
  if (selectedMentions.length === 0 && ctx.config.skills?.implicitSelection) {
    const mode = ctx.config.skills.selectorMode ?? "explicit";
    if (mode === "lexical") {
      effectiveMentions = new SkillSelector(ctx.config.skills.selectorThreshold ?? 0.5, ctx.config.skills.selectorMaxResults ?? 1).select(query, snapshot.skills).selected.map((skill) => skill.canonicalPath);
    } else if (mode === "embedding" || mode === "hybrid") {
      if (!ctx.config.skills.embeddingBaseUrl || !ctx.config.skills.embeddingModel) {
        selectionDiagnostics.push({ severity: "error", code: "skill_embedding_not_configured", message: "embedding/hybrid Skill 选择需要 embedding_base_url 和 embedding_model" });
      } else {
        try {
          const selector = new EmbeddingSkillSelector(new OpenAIEmbeddingClient({ baseUrl: ctx.config.skills.embeddingBaseUrl, model: ctx.config.skills.embeddingModel, apiKey: ctx.config.skills.embeddingApiKey, timeoutMs: ctx.config.skills.embeddingTimeoutMs }), { mode });
          const selected = await selector.select(query, snapshot.skills);
          effectiveMentions = selected.selected.map((skill) => skill.canonicalPath);
          if (selected.ambiguous) selectionDiagnostics.push({ severity: "warning", code: "skill_selection_ambiguous", message: "语义 Skill 选择结果不明确，已跳过自动注入" });
        } catch (error) { selectionDiagnostics.push({ severity: "error", code: "skill_embedding_failed", message: `语义 Skill 选择失败: ${error instanceof Error ? error.message : String(error)}` }); }
      }
    }
  }
  await auditSkillContext(ctx, { source: "skill://selector", operation: "select" }, async () => ({ result: { selectedCount: effectiveMentions.length } }));
  let skillContext = buildSkillContext(ctx.workspaceRoot, snapshot, effectiveMentions, skillOptions);
  if (ctx.skillPlatform) {
    for (const selected of skillContext.selected) {
      const metadata = snapshot.skills.find((skill) => skill.id === selected.skillId);
      if (!metadata?.providerId || metadata.providerId === "local") continue;
      try {
        const body = await ctx.skillPlatform.readAudited(ctx, `${metadata.providerId}:${metadata.canonicalPath}`);
        const hydrated: SkillMetadata[] = snapshot.skills.map((item) => item.id === selected.skillId ? { ...item, body, bodyHash: createHash("sha256").update(body).digest("hex") } : item);
        snapshot = Object.freeze({ ...snapshot, skills: Object.freeze(hydrated) });
        skillContext = buildSkillContext(ctx.workspaceRoot, snapshot, effectiveMentions, skillOptions);
      } catch (error) {
        providerDiagnostics.push({ severity: "warning", code: "skill_provider_read_failed", message: `无法读取远程 Skill ${metadata.name}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
  ctx.instructionSnapshot = instructions;
  ctx.skillSnapshot = skillContext.snapshot;
  ctx.selectedSkills = skillContext.selected;
  ctx.contextualFragments = [...instructionFragments(instructions), ...skillContext.fragments];
  return {
    diagnostics: Object.freeze([...instructions.diagnostics, ...skillContext.diagnostics, ...providerDiagnostics, ...eligibilityDiagnostics, ...selectionDiagnostics]),
    skillContext,
  };
}
