import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentContext, ToolResult } from "../types.js";
import type { AuditRecord } from "../security/audit.js";
import { ScopedContextFileSystem, type ContextFileSystem } from "../config/context-filesystem.js";
import { loadSkillDirectory, type SkillDirectoryLoadResult, type SkillLoadOptions, type SkillMetadata, type SkillRoot, type SkillSnapshot } from "../config/skills.js";
import { loadSkillSnapshot } from "../config/skills.js";
import type { ConfigDiagnostic } from "../config/layered-config.js";
import type { ToolRegistration, ToolRuntime, ToolSpec, RuntimeExecuteOptions } from "../tools/types.js";

export type SkillProviderKind = "local" | "mcp" | "executor" | "orchestrator";

export interface SkillProviderRequest {
  locator: string;
  input?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface SkillProvider {
  readonly id: string;
  readonly kind: SkillProviderKind;
  list(signal?: AbortSignal): Promise<readonly SkillMetadata[]>;
  read(locator: string, signal?: AbortSignal): Promise<string>;
  execute?(request: SkillProviderRequest): Promise<ToolResult>;
  close?(): Promise<void>;
}

export interface RemoteSkillTransport {
  list(request: { provider: string }, signal?: AbortSignal): Promise<readonly RemoteSkillDescription[]>;
  read(request: SkillProviderRequest): Promise<string>;
  execute?(request: SkillProviderRequest): Promise<ToolResult>;
}

export interface RemoteSkillDescription {
  locator: string;
  name: string;
  description: string;
  bodyHash?: string;
  scope?: "user" | "system" | "admin" | "repo";
  enabled?: boolean;
  allowImplicitInvocation?: boolean;
}

/** Adapts MCP/executor/orchestrator transports to the common SkillProvider contract. */
export class RemoteSkillProvider implements SkillProvider {
  constructor(
    public readonly id: string,
    public readonly kind: Exclude<SkillProviderKind, "local">,
    private readonly transport: RemoteSkillTransport,
  ) {}

  async list(signal?: AbortSignal): Promise<readonly SkillMetadata[]> {
    const descriptions = await this.transport.list({ provider: this.id }, signal);
    return descriptions.map((item) => ({
      id: hash(item.locator), name: item.name, description: item.description,
      path: item.locator, canonicalPath: item.locator, rootPath: item.locator,
      scope: item.scope ?? "user", enabled: item.enabled ?? true,
      allowImplicitInvocation: item.allowImplicitInvocation ?? true,
      body: "", bodyHash: item.bodyHash ?? "", diagnostics: [], providerId: this.id,
    }));
  }

  read(locator: string, signal?: AbortSignal): Promise<string> {
    return this.transport.read({ locator, signal });
  }

  execute(request: SkillProviderRequest): Promise<ToolResult> {
    if (!this.transport.execute) return Promise.resolve({ toolName: `skill.${this.id}`, output: "provider 不支持执行", isError: true });
    return this.transport.execute(request);
  }
}

export class CompositeSkillProvider implements SkillProvider {
  readonly kind = "local" as const;
  constructor(public readonly id: string, private readonly providers: readonly SkillProvider[]) {}

  async list(signal?: AbortSignal): Promise<readonly SkillMetadata[]> {
    const batches = await Promise.all(this.providers.map((provider) => provider.list(signal)));
    const byLocator = new Map<string, SkillMetadata>();
    for (const batch of batches) for (const skill of batch) byLocator.set(skill.canonicalPath, skill);
    return [...byLocator.values()].sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
  }

  async read(locator: string, signal?: AbortSignal): Promise<string> {
    const provider = this.providers.find((candidate) => locator.startsWith(`${candidate.id}:`)) ?? this.providers[0];
    if (!provider) throw new Error("没有可用 Skill provider");
    const prefix = `${provider.id}:`;
    return provider.read(locator.startsWith(prefix) ? locator.slice(prefix.length) : locator, signal);
  }

  async execute(request: SkillProviderRequest): Promise<ToolResult> {
    const provider = this.providers.find((candidate) => request.locator.startsWith(`${candidate.id}:`));
    if (!provider?.execute) return { toolName: "skill.execute", output: "没有支持执行的 Skill provider", isError: true };
    return provider.execute(request);
  }
}

export class LocalSkillProvider implements SkillProvider {
  readonly kind = "local" as const;
  private cached?: { signature: string; loadedAt: number; snapshot: SkillSnapshot };
  private readonly rootCache = new Map<string, { loadedAt: number; snapshot: SkillSnapshot; entries: Map<string, SkillMetadata> }>();
  private pluginRoots: readonly string[] = [];
  constructor(public readonly id: string, private readonly cwd: string, private readonly options: SkillLoadOptions = {}) {}

  setPluginRoots(roots: readonly string[]): void {
    this.pluginRoots = [...roots];
    this.cached = undefined;
  }

  async list(): Promise<readonly SkillMetadata[]> {
    const snapshot = await this.snapshot();
    return snapshot.skills.map((skill) => ({ ...skill, providerId: this.id }));
  }

  async read(locator: string): Promise<string> {
    const snapshot = await this.snapshot();
    const skill = snapshot.skills.find((item) => item.canonicalPath === locator || item.path === locator);
    if (!skill) throw new Error(`未找到 Skill: ${locator}`);
    return skill.body;
  }

  async invalidate(root?: string, changedPath?: string): Promise<void> {
    this.cached = undefined;
    if (!root) { this.rootCache.clear(); return; }
    const normalized = path.resolve(root).toLowerCase();
    const matching = [...this.rootCache.entries()].filter(([key]) => key.toLowerCase().startsWith(`${normalized}|`));
    if (!changedPath) { for (const [key] of matching) this.rootCache.delete(key); return; }
    for (const [key, entry] of matching) {
      const updated = await this.refreshRootEntry(entry, root, changedPath);
      if (updated) this.rootCache.set(key, updated);
      else this.rootCache.delete(key);
    }
  }

  private async snapshot(): Promise<SkillSnapshot> {
    const ttl = this.options.cacheTtlMs ?? 5_000;
    const signature = JSON.stringify({
      cwd: path.resolve(this.cwd), roots: this.options.repoRoots, userRoots: [...(this.options.userRoots ?? []), ...this.pluginRoots],
      systemRoots: this.options.systemRoots, adminRoots: this.options.adminRoots,
      enablement: this.options.enablement, model: this.options.model,
    });
    if (this.cached && Date.now() - this.cached.loadedAt < ttl && this.cached.signature === signature) return this.cached.snapshot;
    const projectRoot = path.resolve(this.options.projectRoot ?? this.cwd);
    const batches: Array<{ root: string; load: () => SkillSnapshot }> = [];
    const common: SkillLoadOptions = { ...this.options, enablement: {}, includeCodexCompatibilityRoot: false, repoRoots: [], userRoots: [], systemRoots: [], adminRoots: [] };
    for (const root of this.options.adminRoots ?? []) batches.push({ root, load: () => loadSkillSnapshot(this.cwd, { ...common, adminRoots: [root] }) });
    for (const root of this.options.systemRoots ?? []) batches.push({ root, load: () => loadSkillSnapshot(this.cwd, { ...common, systemRoots: [root] }) });
    for (const root of [...(this.options.userRoots ?? []), ...this.pluginRoots]) batches.push({ root, load: () => loadSkillSnapshot(this.cwd, { ...common, userRoots: [root] }) });
    const repoRoots = this.options.repoRoots ?? [path.join(projectRoot, ".agents", "skills")];
    for (const root of repoRoots) batches.push({ root, load: () => loadSkillSnapshot(this.cwd, { ...common, repoRoots: [root] }) });
    if (this.options.includeCodexCompatibilityRoot !== false) { const root = path.join(projectRoot, ".codex", "skills"); batches.push({ root, load: () => loadSkillSnapshot(this.cwd, { ...common, repoRoots: [root] }) }); }
    const concurrency = Math.max(1, Math.min(32, this.options.scanConcurrency ?? 8));
    const snapshots = await concurrentMap(batches, concurrency, async (batch) => {
      const key = `${path.resolve(batch.root).toLowerCase()}|${signature}`; const cached = this.rootCache.get(key);
      if (cached && Date.now() - cached.loadedAt < ttl) return cached.snapshot;
      const snapshot = batch.load();
      this.rootCache.set(key, { loadedAt: Date.now(), snapshot, entries: new Map(snapshot.skills.map((skill) => [path.dirname(skill.canonicalPath), skill])) });
      return snapshot;
    });
    const byPath = new Map<string, SkillMetadata>();
    for (const batch of snapshots) for (const skill of batch.skills) byPath.set(skill.canonicalPath, { ...skill });
    const skills = [...byPath.values()];
    for (const [locator, enabled] of Object.entries(this.options.enablement ?? {})) {
      const matches = skills.filter((skill) => skill.name === locator || skill.path === locator || skill.canonicalPath === locator);
      if (matches.length === 1) matches[0].enabled = enabled;
    }
    skills.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
    const roots = snapshots.flatMap((batch) => [...batch.roots]);
    const diagnostics = snapshots.flatMap((batch) => [...batch.diagnostics]);
    const snapshot: SkillSnapshot = Object.freeze({ skills: Object.freeze(skills), roots: Object.freeze(roots), catalogFingerprint: hash(skills.filter((skill) => skill.enabled && skill.allowImplicitInvocation).map((skill) => [skill.id, skill.name, skill.description])), fingerprint: hash(skills.map((skill) => [skill.id, skill.enabled, skill.bodyHash])), diagnostics: Object.freeze(diagnostics) });
    this.cached = { signature, loadedAt: Date.now(), snapshot };
    return snapshot;
  }

  private async refreshRootEntry(
    entry: { loadedAt: number; snapshot: SkillSnapshot; entries: Map<string, SkillMetadata> },
    rootPath: string,
    changedPath: string,
  ): Promise<{ loadedAt: number; snapshot: SkillSnapshot; entries: Map<string, SkillMetadata> } | undefined> {
    const root = entry.snapshot.roots[0];
    if (!root) return undefined;
    const changed = path.resolve(changedPath);
    const rootCanonical = path.resolve(root.canonicalPath);
    if (!isWithin(rootCanonical, changed)) return entry;
    const knownDirectory = [...entry.entries.keys()].find((directory) => isWithin(directory, changed));
    const candidate = knownDirectory ?? (path.basename(changed).toLowerCase() === "skill.md" ? path.dirname(changed) : undefined);
    if (!candidate) return undefined;
    const io = this.options.fileSystem ?? new ScopedContextFileSystem([rootCanonical]);
    const result: SkillDirectoryLoadResult = loadSkillDirectory(candidate, root, io);
    const entries = new Map(entry.entries);
    entries.delete(candidate);
    if (result.skill) entries.set(path.resolve(result.skill.canonicalPath, ".."), result.skill);
    const skills = [...entries.values()].sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
    const diagnostics = entry.snapshot.diagnostics.filter((diagnostic) => !diagnostic.sourcePath || !isWithin(candidate, diagnostic.sourcePath));
    const snapshot = makeSkillSnapshot(root, skills, [...diagnostics, ...result.diagnostics], entry.snapshot.roots);
    return { loadedAt: Date.now(), snapshot, entries };
  }
}

function makeSkillSnapshot(
  root: SkillRoot,
  skills: readonly SkillMetadata[],
  diagnostics: readonly ConfigDiagnostic[],
  roots: readonly SkillRoot[] = [root],
): SkillSnapshot {
  const catalogFingerprint = hash(skills.filter((skill) => skill.enabled && skill.allowImplicitInvocation).map((skill) => [skill.id, skill.name, skill.description]));
  const diagnosticsByName = new Map<string, number>();
  for (const skill of skills) diagnosticsByName.set(skill.name, (diagnosticsByName.get(skill.name) ?? 0) + 1);
  const ambiguityDiagnostics: ConfigDiagnostic[] = [...diagnosticsByName.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => ({ severity: "warning", code: "skill_name_ambiguous", message: `skill 名称冲突: ${name}` }));
  const stableDiagnostics = diagnostics.filter((diagnostic) => diagnostic.code !== "skill_name_ambiguous");
  return Object.freeze({
    skills: Object.freeze([...skills]), roots: Object.freeze([...roots]), catalogFingerprint,
    fingerprint: hash({ skills: skills.map((skill) => [skill.id, skill.enabled, skill.allowImplicitInvocation, skill.bodyHash]), diagnostics }),
    diagnostics: Object.freeze([...stableDiagnostics, ...ambiguityDiagnostics]),
  });
}

async function concurrentMap<T, R>(items: readonly T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await mapper(items[index], index); }
  }));
  return results;
}

export interface PluginManifest {
  id: string;
  version: string;
  name?: string;
  description?: string;
  contentHash?: string;
  skills?: readonly string[];
  tools?: readonly string[];
  hooks?: readonly string[];
  mcpServers?: readonly string[];
  requiredPermissions?: readonly string[];
  products?: readonly string[];
  dependencies?: Readonly<Record<string, string>>;
}

export interface MarketplaceDocument {
  manifest: PluginManifest;
  files: Record<string, string>;
}

export interface MarketplaceClientOptions {
  fetcher?: typeof fetch;
  requireHash?: boolean;
  trust?: (manifest: PluginManifest) => boolean | Promise<boolean>;
  authorizeInstall?: (request: { manifest: PluginManifest; destination: string }) => boolean | Promise<boolean>;
}

/** Content-addressed, manifest-first installer. Files are UTF-8 text and paths are root-contained. */
export class MarketplaceClient {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: MarketplaceClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async fetchDocument(url: string, signal?: AbortSignal): Promise<MarketplaceDocument> {
    const response = await this.fetcher(url, { signal });
    if (!response.ok) throw new Error(`Marketplace 请求失败 (${response.status})`);
    const value: unknown = await response.json();
    if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.files)) throw new Error("Marketplace document 格式无效");
    const manifest = parseManifest(value.manifest);
    if (this.options.requireHash !== false && !manifest.contentHash) throw new Error("Marketplace manifest 缺少 contentHash");
    if (this.options.trust && !(await this.options.trust(manifest))) throw new Error("Marketplace manifest 未通过 trust policy");
    const files = stringRecord(value.files);
    if (manifest.contentHash && contentHashForFiles(files) !== manifest.contentHash) throw new Error("Marketplace contentHash 校验失败");
    return { manifest, files };
  }

  async preview(url: string, destination: string, signal?: AbortSignal): Promise<{ manifest: PluginManifest; destination: string; files: readonly string[]; contentHash: string }> {
    const document = await this.fetchDocument(url, signal);
    const root = path.resolve(destination, document.manifest.id, document.manifest.version);
    for (const relative of Object.keys(document.files)) containedPath(root, relative);
    return { manifest: document.manifest, destination: root, files: Object.keys(document.files).sort(), contentHash: contentHashForFiles(document.files) };
  }

  async install(url: string, destination: string, signal?: AbortSignal): Promise<{ manifest: PluginManifest; path: string }> {
    const document = await this.fetchDocument(url, signal);
    if (this.options.authorizeInstall && !(await this.options.authorizeInstall({ manifest: document.manifest, destination: path.resolve(destination) }))) {
      throw new Error("Marketplace 安装未获授权");
    }
    const digest = contentHashForFiles(document.files);
    if (document.manifest.contentHash && digest !== document.manifest.contentHash) throw new Error("Marketplace contentHash 校验失败");
    const root = path.resolve(destination, document.manifest.id, document.manifest.version);
    await fsp.mkdir(root, { recursive: true });
    for (const [relative, content] of Object.entries(document.files)) {
      const target = containedPath(root, relative);
      await assertNoSymlink(root, target);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, { encoding: "utf8", flag: "wx" }).catch(async (error: unknown) => {
        if (isNodeCode(error, "EEXIST")) await fsp.writeFile(target, content, "utf8");
        else throw error;
      });
    }
    await assertNoSymlink(root, path.join(root, "plugin.json"));
    await fsp.writeFile(path.join(root, "plugin.json"), JSON.stringify(document.manifest, null, 2), "utf8");
    return { manifest: document.manifest, path: root };
  }
}
async function assertNoSymlink(root: string, target: string): Promise<void> {
  try {
    if ((await fsp.lstat(root)).isSymbolicLink()) throw new Error(`安装根目录包含符号链接: ${root}`);
  } catch (error) {
    if (!isNodeCode(error, "ENOENT")) throw error;
  }
  const relative = path.relative(path.resolve(root), path.resolve(target));
  const parts = relative.split(path.sep).filter(Boolean);
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`安装路径包含符号链接: ${current}`);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) continue;
      throw error;
    }
  }
}

export class SkillPluginManager {
  private readonly manifests = new Map<string, PluginManifest>();
  constructor(private readonly roots: readonly string[]) {}

  async load(): Promise<readonly PluginManifest[]> {
    this.manifests.clear();
    for (const root of this.roots) await this.walk(path.resolve(root));
    return [...this.manifests.values()].sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`));
  }

  list(): readonly PluginManifest[] { return [...this.manifests.values()]; }

  private async walk(directory: string): Promise<void> {
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === "plugin.json") {
        try {
          const manifest = parseManifest(JSON.parse(await fsp.readFile(target, "utf8")) as unknown);
          if (manifest.contentHash) {
            const content = await pluginContentHash(path.dirname(target));
            if (content !== manifest.contentHash) continue;
          }
          this.manifests.set(`${manifest.id}@${manifest.version}`, manifest);
        } catch { /* invalid plugin is isolated */ }
      } else if (entry.isDirectory()) await this.walk(target);
    }
  }
}

export interface SkillScriptDefinition {
  skillId: string;
  name: string;
  description: string;
  scriptPath: string;
  cwd: string;
  args: readonly string[];
  parameters?: ToolSpec["parameters"];
  readOnly?: boolean;
}

export type SkillScriptRunner = (definition: SkillScriptDefinition, input: Record<string, unknown>, ctx: AgentContext, options?: RuntimeExecuteOptions) => Promise<ToolResult>;

/** Converts declared scripts into normal ToolRegistry registrations; runner is supplied by the ToolRouter boundary. */
export class SkillScriptAdapter {
  constructor(private readonly runner: SkillScriptRunner) {}

  registration(definition: SkillScriptDefinition): ToolRegistration {
    const spec: ToolSpec = {
      name: definition.name, namespace: `skill.${definition.skillId}`, description: definition.description,
      parameters: definition.parameters ?? { type: "object", additionalProperties: true },
      isReadOnly: definition.readOnly ?? false, exposure: "direct", sandbox: { filesystem: "workspace", subprocess: true, workingDirectory: true, environment: "filtered", timeout: true, cancellation: true },
      runtimeCommand: scriptCommand(definition),
    };
    const runtime: ToolRuntime = { execute: (input, ctx, options) => this.runner(definition, input, ctx, options) };
    return { spec, runtime, source: `skill:${definition.skillId}` };
  }
}

/** Default trusted runner for a declared script. Input is passed through a dedicated filtered env key. */
export async function runSkillScript(
  definition: SkillScriptDefinition,
  input: Record<string, unknown>,
  ctx: AgentContext,
  options: RuntimeExecuteOptions = {},
): Promise<ToolResult> {
  const provider = ctx.sandboxProvider;
  if (!provider) return { toolName: `skill.${definition.name}`, output: "Skill script 缺少 sandbox provider", isError: true };
  const result = await provider.execute({
    command: scriptCommand(definition),
    argv: { executable: "node", args: [definition.scriptPath] },
    cwd: definition.cwd,
    timeoutMs: ctx.config.toolTimeoutMs,
    signal: options.signal,
    env: { SWE_SKILL_INPUT_JSON: JSON.stringify(input), SWE_SKILL_ARGS_JSON: JSON.stringify(definition.args) },
    requirements: { filesystem: "workspace", subprocess: true, workingDirectory: true, environment: "filtered", timeout: true, cancellation: true },
  });
  return { toolName: `skill.${definition.name}`, output: [result.stdout, result.stderr].filter(Boolean).join("\n"), isError: result.exitCode !== 0 || result.cancelled || result.timedOut, metadata: { exitCode: result.exitCode, executionId: result.executionId } };
}

export function skillScriptDefinitions(snapshot: SkillSnapshot | readonly SkillMetadata[]): SkillScriptDefinition[] {
  const skills: readonly SkillMetadata[] = "skills" in snapshot ? snapshot.skills : snapshot;
  return skills.filter((skill) => skill.enabled && skill.scripts?.length).flatMap((skill) => skill.scripts!.map((script) => ({
    skillId: skill.id, name: script.name, description: script.description, scriptPath: script.scriptPath, cwd: script.cwd, args: script.args,
    ...(script.parameters ? { parameters: script.parameters } : {}), ...(script.readOnly !== undefined ? { readOnly: script.readOnly } : {}),
  })));
}

function scriptCommand(definition: SkillScriptDefinition): string {
  return `node "${definition.scriptPath.replace(/"/g, "\\\"")}"`;
}

export interface SkillSelectionCandidate { skill: SkillMetadata; score: number; matchedTerms: readonly string[]; }
export interface SemanticSelectionResult { selected: readonly SkillMetadata[]; candidates: readonly SkillSelectionCandidate[]; ambiguous: boolean; }

/** Deterministic lexical-semantic selector; embeddings can replace score() without changing the contract. */
export class SkillSelector {
  constructor(private readonly threshold = 0.2, private readonly maxResults = 3) {}

  select(query: string, skills: readonly SkillMetadata[]): SemanticSelectionResult {
    const queryTerms = terms(query);
    const candidates = skills.filter((skill) => skill.enabled && skill.allowImplicitInvocation).map((skill) => {
      const haystack = terms(`${skill.name} ${skill.description}`);
      const matchedTerms = queryTerms.filter((term) => haystack.includes(term));
      const score = queryTerms.length === 0 ? 0 : matchedTerms.length / queryTerms.length;
      return { skill, score, matchedTerms };
    }).filter((candidate) => candidate.score >= this.threshold).sort((a, b) => b.score - a.score || a.skill.canonicalPath.localeCompare(b.skill.canonicalPath));
    const selected = candidates.slice(0, this.maxResults).filter((candidate, index) => index === 0 || candidate.score === candidates[0].score).map((candidate) => candidate.skill);
    return { selected, candidates, ambiguous: selected.length > 1 && selected.every((skill) => candidates[0].score === candidates.find((item) => item.skill.id === skill.id)?.score) };
  }
}

export interface SkillTokenizer { count(text: string, model?: string): number; }
export class HeuristicSkillTokenizer implements SkillTokenizer {
  count(text: string): number {
    let result = 0;
    for (const character of text) result += /[\u3000-\u9fff\uff00-\uffef]/u.test(character) ? 1 : 0.25;
    return Math.ceil(result);
  }
}
export class ProviderUsageSkillTokenizer implements SkillTokenizer {
  constructor(private readonly fallback: SkillTokenizer = new HeuristicSkillTokenizer(), private readonly usage?: () => number | undefined) {}
  count(text: string, model?: string): number { return this.usage?.() ?? this.fallback.count(text, model); }
}

/** Adapter for a real model tokenizer supplied by the host application. The
 * platform never guesses that a heuristic count is exact: callers can expose
 * their model's tokenizer here and the fallback remains explicit. */
export type SkillTokenizerProvider = (text: string, model?: string) => number | undefined;
export class ModelSkillTokenizer implements SkillTokenizer {
  constructor(private readonly provider: SkillTokenizerProvider, private readonly fallback: SkillTokenizer = new HeuristicSkillTokenizer()) {}
  count(text: string, model?: string): number { return this.provider(text, model) ?? this.fallback.count(text, model); }
}

export interface SkillContextBudget { catalogTokens: number; selectedBodyTokens: number; totalTokens: number; }
export function accountSkillTokens(snapshot: SkillSnapshot, selected: readonly SkillMetadata[], tokenizer: SkillTokenizer = new HeuristicSkillTokenizer()): SkillContextBudget {
  const catalogTokens = snapshot.skills.filter((skill) => skill.enabled && skill.allowImplicitInvocation).reduce((sum, skill) => sum + tokenizer.count(`${skill.name}: ${skill.description}`), 0);
  const selectedBodyTokens = selected.reduce((sum, skill) => sum + tokenizer.count(skill.body), 0);
  return { catalogTokens, selectedBodyTokens, totalTokens: catalogTokens + selectedBodyTokens };
}

export interface SkillContextAuditOptions { callId?: string; source: string; operation: "discover" | "read" | "select" | "install" | "execute"; }
/** Emits redacted preflight/execution audit records for context-source reads. */
export async function auditSkillContext(
  ctx: AgentContext,
  options: SkillContextAuditOptions,
  action: () => Promise<{ bytes?: number; hash?: string; result?: unknown }>,
): Promise<unknown> {
  const callId = options.callId ?? randomUUID();
  const preview: AuditRecord["preview"] = {
    callId, toolName: `skill.${options.operation}`, summary: `${options.operation}: ${options.source}`,
    risk: options.operation === "execute" || options.operation === "install" ? "execute" : "read",
    cwd: ctx.workspaceRoot, affectedPaths: [options.source], reasons: ["Skill context source operation"],
  };
  await ctx.auditTrail.record({ timestamp: Date.now(), callId, toolName: preview.toolName, phase: "preflight", decision: "allow", preview });
  try {
    const result = await action();
    await ctx.auditTrail.record({ timestamp: Date.now(), callId, toolName: preview.toolName, phase: "execution", success: true, preview, input: { source: options.source, bytes: result.bytes, hash: result.hash } });
    return result.result ?? result;
  } catch (error) {
    await ctx.auditTrail.record({ timestamp: Date.now(), callId, toolName: preview.toolName, phase: "execution", success: false, preview, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export interface SkillCacheEntry { key: string; snapshot: SkillSnapshot; signature: string; loadedAt: number; }
export class SkillCache {
  private readonly entries = new Map<string, SkillCacheEntry>();
  get(key: string, signature: string): SkillSnapshot | undefined { const entry = this.entries.get(key); return entry?.signature === signature ? entry.snapshot : undefined; }
  set(key: string, signature: string, snapshot: SkillSnapshot): void { this.entries.set(key, { key, signature, snapshot, loadedAt: Date.now() }); }
  invalidate(key?: string): void { if (key) this.entries.delete(key); else this.entries.clear(); }
  size(): number { return this.entries.size; }
}

export class SkillWatcher {
  private readonly watchers: fs.FSWatcher[] = [];
  constructor(private readonly cache: SkillCache, private readonly onInvalidate?: (root: string, changedPath?: string) => void | Promise<void>) {}
  watch(roots: readonly string[]): void {
    this.close();
    for (const root of roots) {
      try {
        const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
          this.cache.invalidate();
          const changedPath = filename ? path.resolve(root, filename.toString()) : undefined;
          void this.onInvalidate?.(root, changedPath);
        });
        this.watchers.push(watcher);
      } catch { /* unsupported watcher/root is reported by explicit refresh */ }
    }
  }
  close(): void { for (const watcher of this.watchers) watcher.close(); this.watchers.length = 0; }
}

export class SkillPlatform {
  readonly cache = new SkillCache();
  readonly watcher: SkillWatcher;
  private currentSkills: readonly SkillMetadata[] = [];
  private currentDiagnostics: readonly ConfigDiagnostic[] = [];
  constructor(private providers: readonly SkillProvider[]) {
    this.watcher = new SkillWatcher(this.cache, async (root, changedPath) => {
      this.currentSkills = []; this.currentDiagnostics = [];
      for (const provider of this.providers) if (provider instanceof LocalSkillProvider) await provider.invalidate(root, changedPath);
    });
  }
  replaceProviders(providers: readonly SkillProvider[]): void {
    this.providers = [...providers];
    this.currentSkills = [];
    this.currentDiagnostics = [];
    this.cache.invalidate();
  }
  providerList(): readonly SkillProvider[] { return [...this.providers]; }

  async list(signal?: AbortSignal): Promise<readonly SkillMetadata[]> {
    const batches: Array<{ skills: readonly SkillMetadata[]; diagnostics: ConfigDiagnostic[] }> = await Promise.all(this.providers.map(async (provider): Promise<{ skills: readonly SkillMetadata[]; diagnostics: ConfigDiagnostic[] }> => {
      try { return { skills: await provider.list(signal), diagnostics: [] as ConfigDiagnostic[] }; }
      catch (error) {
        return { skills: [] as readonly SkillMetadata[], diagnostics: [{ severity: "warning", code: "skill_provider_unavailable", message: `Skill provider ${provider.id} 不可用: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    }));
    const byIdentity = new Map<string, SkillMetadata>();
    for (const batch of batches) for (const skill of batch.skills) {
      const providerId = skill.providerId ?? "local";
      byIdentity.set(`${providerId}:${skill.id}`, { ...skill, providerId });
    }
    this.currentSkills = [...byIdentity.values()].sort((a, b) => `${a.providerId}:${a.canonicalPath}`.localeCompare(`${b.providerId}:${b.canonicalPath}`));
    this.currentDiagnostics = batches.flatMap((batch) => batch.diagnostics);
    return this.currentSkills;
  }
  diagnostics(): readonly ConfigDiagnostic[] { return this.currentDiagnostics; }
  async listAudited(ctx: AgentContext, signal?: AbortSignal): Promise<readonly SkillMetadata[]> {
    return auditSkillContext(ctx, { source: "skill://catalog", operation: "discover" }, async () => ({ result: await this.list(signal) })) as Promise<readonly SkillMetadata[]>;
  }
  snapshot(base?: SkillSnapshot): SkillSnapshot {
    const skills = this.currentSkills.length > 0 ? this.currentSkills : (base?.skills ?? []);
    const catalogFingerprint = hash(skills.filter((skill) => skill.enabled && skill.allowImplicitInvocation).map(({ id, providerId, name, description }) => ({ id, providerId, name, description })));
    return Object.freeze({
      skills: Object.freeze([...skills]), roots: base?.roots ?? Object.freeze([]),
      fingerprint: hash({ base: base?.fingerprint, skills, diagnostics: this.currentDiagnostics }),
      catalogFingerprint, diagnostics: Object.freeze([...(base?.diagnostics ?? []), ...this.currentDiagnostics]),
    });
  }
  skills(): readonly SkillMetadata[] { return this.currentSkills; }
  hasReadyProvider(id: string): boolean {
    const provider = this.providers.find((candidate) => candidate.id === id);
    if (!provider) return false;
    const state = (provider as SkillProvider & { connectionState?: string }).connectionState;
    return state === undefined || state === "ready";
  }
  /** Exposes provider-owned execution as ordinary tools so ToolRouter applies
   * schema validation, permission decisions, approval, timeout and audit. */
  registrations(): ToolRegistration[] {
    return this.providers.filter((provider) => provider.execute).map((provider) => ({
      spec: {
        name: "execute", namespace: `skill.${provider.id}`,
        description: `在 ${provider.kind} Skill provider 中执行 Skill`,
        parameters: { type: "object", properties: { locator: { type: "string" }, input: { type: "object" } }, required: ["locator"], additionalProperties: false },
        isReadOnly: false, exposure: "direct",
      },
      runtime: { execute: async (input, _ctx, options) => provider.execute!({ locator: String(input.locator), input: (input.input && typeof input.input === "object" && !Array.isArray(input.input)) ? input.input as Record<string, unknown> : {}, signal: options?.signal }) },
      source: `skill-provider:${provider.id}`,
    }));
  }
  async read(locator: string, signal?: AbortSignal): Promise<string> {
    const provider = this.providers.find((candidate) => locator.startsWith(`${candidate.id}:`)) ?? this.providers.find((candidate) => candidate.kind === "local");
    if (!provider) throw new Error("没有匹配的 Skill provider");
    const providerPrefix = `${provider.id}:`;
    const providerLocator = locator.startsWith(providerPrefix) ? locator.slice(providerPrefix.length) : locator;
    return provider.read(providerLocator, signal);
  }
  async readAudited(ctx: AgentContext, locator: string, signal?: AbortSignal): Promise<string> {
    return auditSkillContext(ctx, { source: locator, operation: "read" }, async () => {
      const result = await this.read(locator, signal);
      return { bytes: Buffer.byteLength(result, "utf8"), hash: hash(result), result };
    }) as Promise<string>;
  }
  async close(): Promise<void> { this.watcher.close(); await Promise.all(this.providers.map((provider) => provider.close?.())); }
}

function parseManifest(value: unknown): PluginManifest {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.id) || typeof value.version !== "string") throw new Error("plugin manifest id/version 无效");
  return {
    id: value.id, version: value.version,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.contentHash === "string" ? { contentHash: value.contentHash } : {}),
    ...(Array.isArray(value.skills) ? { skills: value.skills.filter((item): item is string => typeof item === "string") } : {}),
    ...(Array.isArray(value.tools) ? { tools: value.tools.filter((item): item is string => typeof item === "string") } : {}),
    ...(Array.isArray(value.hooks) ? { hooks: value.hooks.filter((item): item is string => typeof item === "string") } : {}),
    ...(Array.isArray(value.mcpServers) ? { mcpServers: value.mcpServers.filter((item): item is string => typeof item === "string") } : {}),
    ...(Array.isArray(value.requiredPermissions) ? { requiredPermissions: value.requiredPermissions.filter((item): item is string => typeof item === "string") } : {}),
    ...(Array.isArray(value.products) ? { products: value.products.filter((item): item is string => typeof item === "string") } : {}),
    ...(isRecord(value.dependencies) ? { dependencies: Object.fromEntries(Object.entries(value.dependencies).map(([id, range]) => {
      if (!/^[A-Za-z0-9._-]+$/.test(id) || typeof range !== "string") throw new Error("plugin manifest dependencies 无效");
      return [id, range];
    })) } : {}),
  };
}
function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item : JSON.stringify(item)]));
}
function containedPath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\") && path.sep !== "\\") throw new Error(`非法相对路径: ${relative}`);
  const target = path.resolve(root, relative);
  if (!isWithin(root, target)) throw new Error(`路径越出安装目录: ${relative}`);
  return target;
}
async function pluginContentHash(root: string): Promise<string> {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name !== "plugin.json") files[path.relative(root, target).replace(/\\/g, "/")] = await fsp.readFile(target, "utf8");
    }
  };
  await walk(root);
  return contentHashForFiles(files);
}
export function contentHashForFiles(files: Record<string, string>): string {
  return hash(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}
function terms(value: string): string[] { return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1))]; }
function hash(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function isWithin(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isNodeCode(error: unknown, code: string): boolean { return isRecord(error) && error.code === code; }

// Keep parseYaml imported as a deliberate extension point for YAML plugin manifests.
export function parsePluginManifestDocument(text: string): PluginManifest { return parseManifest(parseYaml(text)); }
