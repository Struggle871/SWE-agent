import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillsConfig } from "../types.js";
import type { ConfigDiagnostic } from "./layered-config.js";
import { ScopedContextFileSystem, type ContextFileSystem } from "./context-filesystem.js";

export type SkillScope = "repo" | "user" | "system" | "admin";

export interface SkillRoot {
  path: string;
  canonicalPath: string;
  scope: SkillScope;
  version: string;
}

export interface SkillInterfaceMetadata {
  displayName?: string;
  shortDescription?: string;
  iconSmall?: string;
  iconLarge?: string;
  brandColor?: string;
  defaultPrompt?: string;
}

export interface SkillToolDependency {
  type: string;
  value: string;
  description?: string;
  transport?: string;
  command?: string;
  url?: string;
  oauthCallbackPort?: number;
}

export interface SkillPolicy {
  allowImplicitInvocation?: boolean;
  products: string[];
}

export interface SkillScriptMetadata {
  name: string;
  description: string;
  scriptPath: string;
  cwd: string;
  args: string[];
  parameters?: import("../types.js").JsonSchema;
  readOnly?: boolean;
}

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  path: string;
  canonicalPath: string;
  rootPath: string;
  scope: SkillScope;
  enabled: boolean;
  allowImplicitInvocation: boolean;
  shortDescription?: string;
  metadataPath?: string;
  interface?: SkillInterfaceMetadata;
  dependencies?: SkillToolDependency[];
  policy?: SkillPolicy;
  scripts?: SkillScriptMetadata[];
  providerId?: string;
  body: string;
  bodyHash: string;
  diagnostics: readonly ConfigDiagnostic[];
}

export interface SkillSnapshot {
  skills: readonly SkillMetadata[];
  roots: readonly SkillRoot[];
  fingerprint: string;
  catalogFingerprint: string;
  diagnostics: readonly ConfigDiagnostic[];
}

export interface SelectedSkill {
  skillId: string;
  locator: string;
  name: string;
  body: string;
  bodyHash: string;
  explicitMention: string;
}

export interface ContextFragment {
  role: "user" | "developer";
  type: "agents_md.instructions" | "agents_md.replacement" | "agents_md.removal" | "skills.catalog" | "skills.body" | "skills.removal" | "memory.retrieval";
  source: string;
  text: string;
  hash: string;
  id?: string;
  replacesHash?: string;
}

export interface SkillLoadOptions extends SkillsConfig {
  projectRoot?: string;
  trusted?: boolean;
  maxCatalogTokens?: number;
  fileSystem?: ContextFileSystem;
  tokenizer?: { count(text: string, model?: string): number };
  model?: string;
}

export interface SkillSelectionResult {
  selected: readonly SelectedSkill[];
  diagnostics: readonly ConfigDiagnostic[];
}

export interface SkillContext {
  snapshot: SkillSnapshot;
  selected: readonly SelectedSkill[];
  fragments: readonly ContextFragment[];
  diagnostics: readonly ConfigDiagnostic[];
}

export interface SkillDirectoryLoadResult {
  directory: string;
  skill?: SkillMetadata;
  diagnostics: readonly ConfigDiagnostic[];
}

export function discoverSkills(cwd: string, options: SkillLoadOptions = {}): SkillMetadata[] {
  return [...loadSkillSnapshot(cwd, options).skills];
}

export function loadSkillSnapshot(cwd: string, options: SkillLoadOptions = {}): SkillSnapshot {
  const projectRoot = path.resolve(options.projectRoot ?? cwd);
  const io = options.fileSystem ?? new ScopedContextFileSystem([projectRoot, ...(options.userRoots ?? []), ...(options.systemRoots ?? []), ...(options.adminRoots ?? [])]);
  const diagnostics: ConfigDiagnostic[] = [];
  const roots = buildRoots(projectRoot, options, diagnostics, io);
  const skills: SkillMetadata[] = [];
  if (options.trusted === false) {
    diagnostics.push({ severity: "warning", code: "untrusted_project_skills", message: "项目未受信任，repo skills 未读取" });
  }
  for (const root of roots) {
    if (root.scope === "repo" && options.trusted === false) continue;
    scanRoot(root, options, skills, diagnostics, io);
  }
  applyEnablement(skills, options.enablement ?? {}, diagnostics);
  skills.sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
  for (const [name, matches] of groupByName(skills)) {
    if (matches.length > 1) diagnostics.push({ severity: "warning", code: "skill_name_ambiguous", message: `skill 名称冲突: ${name}` });
  }
  const catalogFingerprint = hash(skills
    .filter((skill) => skill.enabled && skill.allowImplicitInvocation)
    .map(({ id, name, description, shortDescription }) => ({ id, name, description, shortDescription })));
  const fingerprint = hash({
    roots, catalogFingerprint,
    skills: skills.map(({ id, enabled, allowImplicitInvocation, bodyHash, metadataPath }) => ({ id, enabled, allowImplicitInvocation, bodyHash, metadataPath })),
    diagnostics: diagnostics.map(({ code, sourcePath }) => ({ code, sourcePath })),
  });
  return Object.freeze({
    skills: Object.freeze(skills), roots: Object.freeze(roots), fingerprint, catalogFingerprint,
    diagnostics: Object.freeze(diagnostics),
  });
}

export function selectSkills(snapshot: SkillSnapshot, mentions: readonly string[], options: SkillLoadOptions = {}): SkillSelectionResult {
  const selected: SelectedSkill[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  const seen = new Set<string>();
  const perSkill = positiveInteger(options.maxSelectedBodyTokensPerSkill ?? 8_000, "skill body per-skill budget");
  const totalLimit = positiveInteger(options.maxSelectedBodyTokensTotal ?? 16_000, "skill body total budget");
  let total = 0;
  for (const mention of mentions) {
    const matches = resolveMention(snapshot.skills, mention);
    if (matches.length === 0) {
      diagnostics.push({ severity: "error", code: "skill_not_found", message: `未找到 skill: ${mention}` });
      continue;
    }
    if (matches.length > 1) {
      diagnostics.push({ severity: "error", code: "skill_name_ambiguous", message: `skill 名称不唯一，请使用路径: ${mention}` });
      continue;
    }
    const skill = matches[0];
    if (!skill.enabled) {
      diagnostics.push({ severity: "error", code: "skill_disabled", message: `skill 已禁用: ${mention}`, sourcePath: skill.path });
      continue;
    }
    if (seen.has(skill.id)) continue;
    const tokens = options.tokenizer?.count(skill.body, options.model) ?? estimateTokens(skill.body);
    if (tokens > perSkill) {
      diagnostics.push({ severity: "error", code: "skill_body_budget_exceeded", message: `skill 正文超过单项预算: ${skill.name}`, sourcePath: skill.path });
      continue;
    }
    if (total + tokens > totalLimit) {
      diagnostics.push({ severity: "error", code: "skill_total_budget_exceeded", message: `skill 正文超过总预算: ${skill.name}`, sourcePath: skill.path });
      continue;
    }
    total += tokens;
    seen.add(skill.id);
    selected.push({
      skillId: skill.id, locator: skill.canonicalPath, name: skill.name, body: skill.body,
      bodyHash: skill.bodyHash, explicitMention: mention,
    });
  }
  return { selected: Object.freeze(selected), diagnostics: Object.freeze(diagnostics) };
}

export function loadSkillContext(cwd: string, selectedMentions: readonly string[] = [], options: SkillLoadOptions = {}): SkillContext {
  const snapshot = loadSkillSnapshot(cwd, options);
  return buildSkillContext(cwd, snapshot, selectedMentions, options);
}

/** Builds contextual fragments from an already discovered snapshot. Providers can
 * refresh metadata independently and hand the frozen snapshot to this function. */
export function buildSkillContext(cwd: string, snapshot: SkillSnapshot, selectedMentions: readonly string[] = [], options: SkillLoadOptions = {}): SkillContext {
  const selection = selectSkills(snapshot, selectedMentions, options);
  const fragments: ContextFragment[] = [];
  const catalog = renderCatalog(snapshot, options.maxCatalogTokens ?? options.maxContextTokens);
  if (catalog) fragments.push(fragment("developer", "skills.catalog", path.resolve(cwd), catalog));
  for (const skill of selection.selected) {
    fragments.push(fragment("user", "skills.body", skill.locator, `<skill name="${escapeAttribute(skill.name)}" locator="${escapeAttribute(skill.locator)}" hash="${skill.bodyHash}">\n${skill.body}\n</skill>`, skill.skillId));
  }
  return {
    snapshot, selected: selection.selected, fragments: Object.freeze(fragments),
    diagnostics: Object.freeze([...snapshot.diagnostics, ...selection.diagnostics]),
  };
}

export function loadSkillFragments(cwd: string, selectedMentions: readonly string[] = [], options: SkillLoadOptions = {}): ContextFragment[] {
  return [...loadSkillContext(cwd, selectedMentions, options).fragments];
}

export function extractSkillMentions(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)\$([A-Za-z0-9_-]{1,64})(?=\s|$|[.,;:!?，。；：！？])/g)].map((match) => match[1]);
}

export function resolveSkillResource(skill: SkillMetadata, relativePath: string, fileSystem?: ContextFileSystem): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("skill resource 必须是相对路径");
  const root = path.dirname(skill.canonicalPath);
  const resolved = path.resolve(root, relativePath);
  if (!isWithin(root, resolved)) throw new Error("skill resource 越出 skill 根目录");
  const io = fileSystem ?? new ScopedContextFileSystem([root]);
  if (!io.exists(resolved)) return resolved;
  const canonical = io.realpath(resolved);
  if (!isWithin(root, canonical)) throw new Error("skill resource 解析后越出 skill 根目录");
  return canonical;
}

function buildRoots(projectRoot: string, options: SkillLoadOptions, diagnostics: ConfigDiagnostic[], io: ContextFileSystem): SkillRoot[] {
  const requested: Array<{ path: string; scope: SkillScope }> = [];
  for (const root of options.adminRoots ?? []) requested.push({ path: root, scope: "admin" });
  for (const root of options.systemRoots ?? []) requested.push({ path: root, scope: "system" });
  for (const root of options.userRoots ?? []) requested.push({ path: root, scope: "user" });
  const repoRoots = options.repoRoots ?? [path.join(projectRoot, ".agents", "skills")];
  for (const root of repoRoots) requested.push({ path: path.resolve(projectRoot, root), scope: "repo" });
  if (options.includeCodexCompatibilityRoot !== false) requested.push({ path: path.join(projectRoot, ".codex", "skills"), scope: "repo" });
  const roots: SkillRoot[] = [];
  const seen = new Set<string>();
  for (const requestedRoot of requested.slice(0, 8)) {
    const absolute = path.resolve(requestedRoot.path);
    if (!io.isDirectory(absolute)) continue;
    const canonicalPath = io.realpath(absolute);
    const key = canonicalPath.toLowerCase();
    if (seen.has(key)) continue;
    if (requestedRoot.scope === "repo" && !isWithin(projectRoot, canonicalPath)) {
      diagnostics.push({ severity: "error", code: "skill_root_escape", message: "repo skill root 越出项目根目录", sourcePath: absolute });
      continue;
    }
    seen.add(key);
    roots.push({ path: absolute, canonicalPath, scope: requestedRoot.scope, version: hash(canonicalPath) });
  }
  if (requested.length > 8) diagnostics.push({ severity: "warning", code: "skill_root_limit", message: "skill roots 超过 8 个，尾部 roots 已省略" });
  return roots;
}

function scanRoot(root: SkillRoot, options: SkillLoadOptions, result: SkillMetadata[], diagnostics: ConfigDiagnostic[], io: ContextFileSystem): void {
  const maxDepth = positiveInteger(options.maxScanDepth ?? 6, "skill scan depth");
  const maxEntries = positiveInteger(options.maxEntriesPerRoot ?? 20_000, "skill entry limit");
  const maxSkills = positiveInteger(options.maxSkills ?? 2_000, "skill count limit");
  let entries = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth || entries >= maxEntries || result.length >= maxSkills) return;
    let children: fs.Dirent[];
    try { children = io.readDirectory(directory).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) {
      diagnostics.push({ severity: "warning", code: "skill_directory_unreadable", message: String(error), sourcePath: directory });
      return;
    }
    entries += children.length;
    const skillEntry = children.find((entry) => entry.name === "SKILL.md" && entry.isFile());
    if (skillEntry) loadOneSkill(path.join(directory, skillEntry.name), root, result, diagnostics, io);
    for (const entry of children) {
      if (entries >= maxEntries || result.length >= maxSkills) break;
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      visit(path.join(directory, entry.name), depth + 1);
    }
  };
  visit(root.canonicalPath, 0);
  if (entries >= maxEntries) diagnostics.push({ severity: "warning", code: "skill_entry_limit", message: `skill root 达到 ${maxEntries} entries 限制`, sourcePath: root.path });
  if (result.length >= maxSkills) diagnostics.push({ severity: "warning", code: "skill_count_limit", message: `skill discovery 达到 ${maxSkills} 项限制`, sourcePath: root.path });
}

function loadOneSkill(skillPath: string, root: SkillRoot, result: SkillMetadata[], diagnostics: ConfigDiagnostic[], io: ContextFileSystem): void {
  try {
    const canonicalPath = io.realpath(skillPath);
    if (!isWithin(root.canonicalPath, canonicalPath)) throw new Error("SKILL.md 越出声明 root");
    const body = io.readText(canonicalPath);
    const parsed = parseSkill(body, path.basename(path.dirname(canonicalPath)));
    const optionalMetadata = loadOptionalSkillMetadata(canonicalPath, io);
    diagnostics.push(...optionalMetadata.diagnostics);
    result.push({
      id: hash(canonicalPath), name: parsed.name, description: parsed.description,
      path: path.resolve(skillPath), canonicalPath, rootPath: root.canonicalPath, scope: root.scope,
      enabled: true,
      allowImplicitInvocation: optionalMetadata.allowImplicitInvocation ?? parsed.allowImplicitInvocation,
      ...(parsed.shortDescription ? { shortDescription: parsed.shortDescription } : {}),
      ...(optionalMetadata.metadataPath ? { metadataPath: optionalMetadata.metadataPath } : {}),
      ...(optionalMetadata.interface ? { interface: optionalMetadata.interface } : {}),
      ...(optionalMetadata.dependencies ? { dependencies: optionalMetadata.dependencies } : {}),
      ...(optionalMetadata.policy ? { policy: optionalMetadata.policy } : {}),
      ...(optionalMetadata.scripts ? { scripts: optionalMetadata.scripts } : {}),
      body, bodyHash: hash(body), diagnostics: Object.freeze(optionalMetadata.diagnostics),
    });
  } catch (error) {
    diagnostics.push({ severity: "warning", code: "invalid_skill", message: error instanceof Error ? error.message : String(error), sourcePath: skillPath });
  }
}

/** Loads exactly one Skill directory. This is the incremental watcher entry
 * point; it deliberately does not traverse sibling directories. */
export function loadSkillDirectory(
  directory: string,
  root: SkillRoot,
  io: ContextFileSystem,
): SkillDirectoryLoadResult {
  const canonicalDirectory = path.resolve(directory);
  const diagnostics: ConfigDiagnostic[] = [];
  const skillPath = path.join(canonicalDirectory, "SKILL.md");
  if (!io.isFile(skillPath)) return { directory: canonicalDirectory, diagnostics: Object.freeze([]) };
  const result: SkillMetadata[] = [];
  loadOneSkill(skillPath, root, result, diagnostics, io);
  return { directory: canonicalDirectory, ...(result[0] ? { skill: result[0] } : {}), diagnostics: Object.freeze(diagnostics) };
}

function parseSkill(body: string, fallbackName: string): {
  name: string;
  description: string;
  shortDescription?: string;
  allowImplicitInvocation: boolean;
} {
  const normalized = body.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SKILL.md frontmatter missing");
  const marker = normalized.indexOf("\n---", 4);
  if (marker < 0 || (normalized.length > marker + 4 && normalized[marker + 4] !== "\n")) throw new Error("SKILL.md frontmatter invalid");
  const fields = parseYamlRecord(normalized.slice(4, marker), "SKILL.md frontmatter");
  const name = normalizeLine(optionalString(fields.name, "SKILL.md name") ?? fallbackName);
  const description = normalizeLine(optionalString(fields.description, "SKILL.md description") ?? "");
  if (!name || [...name].length > 64) throw new Error("SKILL.md name invalid");
  if (!description || description.length > 1_024) throw new Error("SKILL.md description invalid");
  const metadata = fields.metadata === undefined ? undefined : record(fields.metadata, "SKILL.md metadata");
  const shortDescription = normalizeLine(optionalString(metadata?.["short-description"], "SKILL.md metadata.short-description") ?? "");
  const disabledValue = fields["disable-model-invocation"] ?? fields.disable_model_invocation;
  if (disabledValue !== undefined && typeof disabledValue !== "boolean") throw new Error("SKILL.md disable-model-invocation invalid");
  return {
    name, description,
    ...(shortDescription ? { shortDescription } : {}),
    allowImplicitInvocation: disabledValue !== true,
  };
}

function loadOptionalSkillMetadata(
  skillPath: string,
  io: ContextFileSystem,
): { allowImplicitInvocation?: boolean; metadataPath?: string; interface?: SkillInterfaceMetadata; dependencies?: SkillToolDependency[]; policy?: SkillPolicy; scripts?: SkillScriptMetadata[]; diagnostics: ConfigDiagnostic[] } {
  const candidate = path.join(path.dirname(skillPath), "agents", "openai.yaml");
  if (!io.isFile(candidate)) return { diagnostics: [] };
  let canonicalPath = candidate;
  try {
    canonicalPath = io.realpath(candidate);
    if (!isWithin(path.dirname(skillPath), canonicalPath)) throw new Error("openai.yaml 越出 skill 根目录");
    const parsed = parseYamlRecord(io.readText(canonicalPath), "agents/openai.yaml");
    const policy = parsed.policy === undefined ? undefined : record(parsed.policy, "agents/openai.yaml policy");
    const implicit = policy?.allow_implicit_invocation;
    if (implicit !== undefined && typeof implicit !== "boolean") throw new Error("agents/openai.yaml policy.allow_implicit_invocation 必须是布尔值");
    const productValue = parsed.products ?? policy?.products;
    const products = productValue === undefined ? [] : stringArray(productValue, "agents/openai.yaml products");
    const interfaceMetadata = parsed.interface === undefined ? undefined : parseInterface(record(parsed.interface, "agents/openai.yaml interface"));
    const dependencies = parsed.dependencies === undefined ? undefined : parseDependencies(record(parsed.dependencies, "agents/openai.yaml dependencies"));
    const scripts = parsed.scripts === undefined ? undefined : parseScripts(parsed.scripts, path.dirname(skillPath), io);
    return {
      ...(implicit !== undefined ? { allowImplicitInvocation: implicit } : {}),
      metadataPath: canonicalPath,
      ...(interfaceMetadata ? { interface: interfaceMetadata } : {}),
      ...(dependencies ? { dependencies } : {}),
      ...((implicit !== undefined || products.length > 0) ? { policy: { ...(implicit !== undefined ? { allowImplicitInvocation: implicit } : {}), products } } : {}),
      ...(scripts ? { scripts } : {}),
      diagnostics: [],
    };
  } catch (error) {
    return {
      metadataPath: canonicalPath,
      diagnostics: [{
        severity: "warning",
        code: "invalid_skill_metadata",
        message: `忽略无效的可选 skill metadata: ${error instanceof Error ? error.message : String(error)}`,
        sourcePath: candidate,
      }],
    };
  }
}

function parseInterface(value: Record<string, unknown>): SkillInterfaceMetadata {
  assertKnown(value, ["display_name", "short_description", "icon_small", "icon_large", "brand_color", "default_prompt"], "agents/openai.yaml interface");
  const read = (key: string): string | undefined => value[key] === undefined ? undefined : optionalString(value[key], `agents/openai.yaml interface.${key}`);
  const brandColor = read("brand_color");
  if (brandColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(brandColor)) throw new Error("agents/openai.yaml interface.brand_color 必须是 #RRGGBB");
  return {
    ...(read("display_name") ? { displayName: read("display_name") } : {}),
    ...(read("short_description") ? { shortDescription: read("short_description") } : {}),
    ...(read("icon_small") ? { iconSmall: read("icon_small") } : {}),
    ...(read("icon_large") ? { iconLarge: read("icon_large") } : {}),
    ...(brandColor ? { brandColor } : {}),
    ...(read("default_prompt") ? { defaultPrompt: read("default_prompt") } : {}),
  };
}
function parseDependencies(value: Record<string, unknown>): SkillToolDependency[] {
  const tools = value.tools;
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) throw new Error("agents/openai.yaml dependencies.tools 必须是数组");
  return tools.map((item, index) => {
    const tool = record(item, `agents/openai.yaml dependencies.tools[${index}]`);
    if (typeof tool.type !== "string" || typeof tool.value !== "string") throw new Error("Skill dependency 需要 type/value");
    return {
      type: tool.type, value: tool.value,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(typeof tool.transport === "string" ? { transport: tool.transport } : {}),
      ...(typeof tool.command === "string" ? { command: tool.command } : {}),
      ...(typeof tool.url === "string" ? { url: tool.url } : {}),
    };
  });
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${label} 必须是字符串数组`);
  return value as string[];
}
function assertKnown(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`${label} 包含未知字段: ${key}`);
}
function parseScripts(value: unknown, skillRoot: string, io: ContextFileSystem): SkillScriptMetadata[] {
  if (!Array.isArray(value)) throw new Error("agents/openai.yaml scripts 必须是数组");
  return value.map((item, index) => {
    const script = record(item, `agents/openai.yaml scripts[${index}]`);
    assertKnown(script, ["name", "description", "path", "cwd", "args", "parameters", "read_only"], `agents/openai.yaml scripts[${index}]`);
    if (typeof script.name !== "string" || typeof script.description !== "string" || typeof script.path !== "string") throw new Error("Skill script 需要 name/description/path");
    const requestedPath = path.resolve(skillRoot, script.path);
    if (!isWithin(skillRoot, requestedPath) || !io.isFile(requestedPath)) throw new Error(`Skill script 路径无效: ${script.path}`);
    const scriptPath = io.realpath(requestedPath);
    if (!isWithin(skillRoot, scriptPath) || !/\.(?:mjs|cjs|js)$/i.test(scriptPath)) throw new Error(`Skill script 必须是根目录内的 JavaScript 文件: ${script.path}`);
    const requestedCwd = path.resolve(skillRoot, typeof script.cwd === "string" ? script.cwd : ".");
    if (!isWithin(skillRoot, requestedCwd) || !io.isDirectory(requestedCwd)) throw new Error(`Skill script cwd 无效: ${String(script.cwd ?? ".")}`);
    const cwd = io.realpath(requestedCwd);
    if (!isWithin(skillRoot, cwd)) throw new Error("Skill script cwd 解析后越出 skill 根目录");
    const args = script.args === undefined ? [] : stringArray(script.args, `agents/openai.yaml scripts[${index}].args`);
    if (args.some((arg) => /[\r\n\0]/.test(arg))) throw new Error("Skill script args 包含非法控制字符");
    return {
      name: script.name, description: script.description, scriptPath, cwd, args,
      ...(script.parameters ? { parameters: script.parameters as import("../types.js").JsonSchema } : {}),
      ...(typeof script.read_only === "boolean" ? { readOnly: script.read_only } : {}),
    };
  });
}

function applyEnablement(skills: SkillMetadata[], rules: Readonly<Record<string, boolean>>, diagnostics: ConfigDiagnostic[]): void {
  const groups = groupByName(skills);
  for (const [locator, enabled] of Object.entries(rules)) {
    const canonical = path.isAbsolute(locator) ? path.resolve(locator).toLowerCase() : undefined;
    const pathMatches = canonical ? skills.filter((skill) => skill.canonicalPath.toLowerCase() === canonical) : [];
    if (pathMatches.length === 1) { pathMatches[0].enabled = enabled; continue; }
    const nameMatches = groups.get(locator) ?? [];
    if (nameMatches.length === 1) nameMatches[0].enabled = enabled;
    else if (nameMatches.length > 1) diagnostics.push({ severity: "warning", code: "skill_enablement_ambiguous", message: `enablement 名称不唯一: ${locator}` });
    else diagnostics.push({ severity: "warning", code: "skill_enablement_unmatched", message: `enablement 未匹配 skill: ${locator}` });
  }
}

function renderCatalog(snapshot: SkillSnapshot, requestedBudget?: number): string {
  const enabled = snapshot.skills.filter((skill) => skill.enabled && skill.allowImplicitInvocation);
  if (enabled.length === 0) return "";
  const budget = Math.max(0, Math.min(10_000, requestedBudget ?? 8_000));
  const minimum = enabled.map((skill) => `- ${escapeCatalog(skill.name)} (${escapeCatalog(skill.canonicalPath)})`);
  const included: typeof enabled = [];
  let used = 0;
  for (let index = 0; index < enabled.length; index += 1) {
    const cost = estimateTokens(minimum[index] + "\n");
    if (used + cost > budget) break;
    used += cost;
    included.push(enabled[index]);
  }
  if (included.length === 0) return "";
  const remaining = Math.max(0, budget - used - included.length);
  const share = Math.floor(remaining / included.length);
  return included.map((skill, index) => {
    const description = truncateToTokens(escapeCatalog(skill.description), share);
    return description ? `${minimum[index]}: ${description}` : minimum[index];
  }).join("\n");
}

function resolveMention(skills: readonly SkillMetadata[], mention: string): SkillMetadata[] {
  const absolute = path.isAbsolute(mention) ? path.resolve(mention).toLowerCase() : undefined;
  if (absolute) return skills.filter((skill) => skill.canonicalPath.toLowerCase() === absolute || skill.path.toLowerCase() === absolute);
  return skills.filter((skill) => skill.name === mention || skill.canonicalPath === mention || skill.path === mention || `${skill.providerId ?? "local"}:${skill.canonicalPath}` === mention);
}

function groupByName(skills: readonly SkillMetadata[]): Map<string, SkillMetadata[]> {
  const result = new Map<string, SkillMetadata[]>();
  for (const skill of skills) result.set(skill.name, [...(result.get(skill.name) ?? []), skill]);
  return result;
}

function fragment(role: ContextFragment["role"], type: ContextFragment["type"], source: string, text: string, id?: string): ContextFragment {
  return { role, type, source, text, hash: hash(text), ...(id ? { id } : {}) };
}
function truncateToTokens(value: string, budget: number): string {
  if (estimateTokens(value) <= budget) return value;
  let result = "";
  for (const character of value) {
    if (estimateTokens(result + character + "...") > budget) break;
    result += character;
  }
  return result ? `${result}...` : "";
}
function estimateTokens(value: string): number {
  let tokens = 0;
  for (const character of value) tokens += /[\u3000-\u9fff\uff00-\uffef]/u.test(character) ? 1 : 0.25;
  return Math.ceil(tokens);
}
function normalizeLine(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function parseYamlRecord(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(value, { uniqueKeys: true });
  } catch (error) {
    throw new Error(`${label} YAML 无效: ${error instanceof Error ? error.message : String(error)}`);
  }
  return record(parsed, label);
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  return value;
}
function escapeCatalog(value: string): string { return value.replace(/[\r\n\t]/g, " ").replace(/[<>]/g, ""); }
function escapeAttribute(value: string): string { return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`);
  return value;
}
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function hash(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
