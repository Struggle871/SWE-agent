import fs from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { MarketplaceClient, type MarketplaceDocument, type PluginManifest, contentHashForFiles, type SkillScriptDefinition } from "./platform.js";
import type { HookConfig, SkillMcpServerConfig } from "../types.js";

export interface MarketplaceEntry { url: string; manifest: PluginManifest; }
export interface PluginRecord { id: string; activeVersion?: string; enabled: boolean; versions: string[]; }
export interface PluginLifecycleCheckpoint { records: PluginRecord[]; backupRoot: string }
export interface PluginRuntimeCapabilities { products?: readonly string[]; permissions?: readonly string[]; }
export interface PluginRuntimeContribution {
  pluginId: string;
  version: string;
  root: string;
  hooks: HookConfig[];
  mcpServers: Record<string, SkillMcpServerConfig>;
  scripts: SkillScriptDefinition[];
}

export class MarketplaceIndex {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async search(indexes: readonly string[], query: string, signal?: AbortSignal): Promise<readonly MarketplaceEntry[]> {
    const results: MarketplaceEntry[] = [];
    for (const index of indexes) {
      const response = await this.fetcher(index, { signal });
      if (!response.ok) throw new Error(`Marketplace index 请求失败 (${response.status})`);
      const value: unknown = await response.json();
      const entries = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { plugins?: unknown }).plugins) ? (value as { plugins: unknown[] }).plugins : [];
      for (const item of entries) {
        if (!item || typeof item !== "object") continue;
        const row = item as { url?: unknown; manifest?: unknown; id?: unknown; version?: unknown; name?: unknown; description?: unknown };
        if (typeof row.url !== "string") continue;
        const manifest = row.manifest && typeof row.manifest === "object" ? row.manifest as PluginManifest : { id: String(row.id ?? ""), version: String(row.version ?? "0.0.0"), name: typeof row.name === "string" ? row.name : undefined, description: typeof row.description === "string" ? row.description : undefined };
        const haystack = `${manifest.id} ${manifest.name ?? ""} ${manifest.description ?? ""}`.toLocaleLowerCase();
        if (!query || haystack.includes(query.toLocaleLowerCase())) results.push({ url: row.url, manifest });
      }
    }
    return results.sort((a, b) => `${a.manifest.id}@${a.manifest.version}`.localeCompare(`${b.manifest.id}@${b.manifest.version}`));
  }
  resolve(entries: readonly MarketplaceEntry[], id: string, range = "*"): MarketplaceEntry | undefined {
    return entries.filter((entry) => entry.manifest.id === id && semver.valid(entry.manifest.version) && semver.satisfies(entry.manifest.version, range)).sort((a, b) => semver.rcompare(a.manifest.version, b.manifest.version))[0];
  }
}

export class PluginLifecycleManager {
  private records = new Map<string, PluginRecord>();
  private loaded = false;
  constructor(private readonly installRoot: string, private readonly registryPath = path.join(installRoot, "registry.json"), private readonly marketplace = new MarketplaceClient(), private readonly capabilities: PluginRuntimeCapabilities = {}) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.registryPath, "utf8"));
      if (parsed && typeof parsed === "object") for (const [id, value] of Object.entries(parsed)) if (/^[A-Za-z0-9._-]+$/.test(id) && value && typeof value === "object") {
        const row = value as Partial<PluginRecord>;
        this.records.set(id, { id, enabled: row.enabled !== false, versions: Array.isArray(row.versions) ? row.versions.filter((v): v is string => typeof v === "string") : [], ...(typeof row.activeVersion === "string" ? { activeVersion: row.activeVersion } : {}) });
      }
    } catch (error) { if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error; }
  }

  list(): readonly PluginRecord[] { return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  isEnabled(id: string): boolean { return this.records.get(id)?.enabled === true; }
  activeRoots(): string[] { return this.list().filter((record) => record.enabled && record.activeVersion).map((record) => path.join(this.installRoot, record.id, record.activeVersion!)); }

  async checkpoint(): Promise<PluginLifecycleCheckpoint> {
    await this.load();
    await fs.mkdir(this.installRoot, { recursive: true });
    const backupRoot = await fs.mkdtemp(path.join(this.installRoot, ".checkpoint-"));
    const records = this.list().map((record) => ({ ...record, versions: [...record.versions] }));
    try {
      for (const record of records) for (const version of record.versions) {
        const source = path.join(this.installRoot, record.id, version);
        const target = path.join(backupRoot, record.id, version);
        try { await fs.cp(source, target, { recursive: true, errorOnExist: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return { records, backupRoot };
    } catch (error) {
      await fs.rm(backupRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async restore(checkpoint: PluginLifecycleCheckpoint): Promise<void> {
    await this.load();
    const expected = new Map(checkpoint.records.map((record) => [record.id, new Set(record.versions)]));
    for (const record of this.list()) for (const version of record.versions) {
      if (!expected.get(record.id)?.has(version)) await fs.rm(path.join(this.installRoot, record.id, version), { recursive: true, force: true });
    }
    for (const record of checkpoint.records) for (const version of record.versions) {
      const source = path.join(checkpoint.backupRoot, record.id, version);
      const target = path.join(this.installRoot, record.id, version);
      try { await fs.rm(target, { recursive: true, force: true }); await fs.cp(source, target, { recursive: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.records = new Map(checkpoint.records.map((record) => [record.id, { ...record, versions: [...record.versions] }]));
    await this.persist();
    await this.discard(checkpoint);
  }

  async discard(checkpoint: PluginLifecycleCheckpoint): Promise<void> {
    await fs.rm(checkpoint.backupRoot, { recursive: true, force: true });
  }

  async contributions(): Promise<PluginRuntimeContribution[]> {
    await this.load();
    const result: PluginRuntimeContribution[] = [];
    for (const record of this.list().filter((item) => item.enabled && item.activeVersion)) {
      const root = path.resolve(this.installRoot, record.id, record.activeVersion!);
      const manifest = await readManifest(root);
      const hooks = await readHooks(root, manifest.hooks ?? [], `${record.id}@${record.activeVersion}`);
      const mcpServers = await readMcpServers(root, manifest.mcpServers ?? [], `${record.id}@${record.activeVersion}`);
      const scripts = await readScripts(root, manifest.tools ?? [], record.id);
      result.push({ pluginId: record.id, version: record.activeVersion!, root, hooks, mcpServers, scripts });
    }
    return result;
  }

  async install(url: string, signal?: AbortSignal, index?: MarketplaceIndex, indexes: readonly string[] = []): Promise<PluginRecord> {
    await this.load();
    const document = await this.marketplace.fetchDocument(url, signal);
    if (Object.keys(document.manifest.dependencies ?? {}).length) {
      if (!index || indexes.length === 0) throw new Error(`插件 ${document.manifest.id} 声明了依赖，但没有可用 Marketplace index`);
      for (const [dependency, range] of Object.entries(document.manifest.dependencies ?? {})) {
        const installed = this.records.get(dependency)?.activeVersion;
        if (installed && semver.satisfies(installed, range)) continue;
        const candidate = index.resolve(await index.search(indexes, dependency, signal), dependency, range);
        if (!candidate) throw new Error(`缺少插件依赖: ${dependency}@${range}`);
        await this.installWithDependencies(candidate, index, indexes, new Set([document.manifest.id]), signal);
      }
    }
    return this.installDocument(document);
  }

  private async installDocument(document: MarketplaceDocument): Promise<PluginRecord> {
    this.validateRuntime(document.manifest);
    const root = path.resolve(this.installRoot, document.manifest.id, document.manifest.version);
    await this.atomicInstall(document, root);
    const record = this.records.get(document.manifest.id) ?? { id: document.manifest.id, enabled: true, versions: [] };
    record.versions = [...new Set([...record.versions, document.manifest.version])].sort(semver.compare);
    record.activeVersion = document.manifest.version; record.enabled = true;
    this.records.set(record.id, record); await this.persist(); return { ...record };
  }

  async enable(id: string): Promise<void> { await this.load(); const record = this.require(id); record.enabled = true; await this.persist(); }
  async disable(id: string): Promise<void> { await this.load(); const record = this.require(id); record.enabled = false; await this.persist(); }
  async uninstall(id: string, version?: string): Promise<void> {
    await this.load(); const record = this.require(id); const target = version ?? record.activeVersion;
    if (!target) return;
    await fs.rm(path.resolve(this.installRoot, id, target), { recursive: true, force: false });
    record.versions = record.versions.filter((item) => item !== target);
    if (record.activeVersion === target) record.activeVersion = record.versions.at(-1);
    if (record.versions.length === 0) this.records.delete(id); await this.persist();
  }
  async upgrade(id: string, index: MarketplaceIndex, indexes: readonly string[], range = "*", signal?: AbortSignal): Promise<PluginRecord> {
    await this.load(); const entries = await index.search(indexes, id, signal); const candidate = index.resolve(entries, id, range);
    if (!candidate) throw new Error(`没有满足 ${id}@${range} 的 Marketplace 版本`);
    return this.installWithDependencies(candidate, index, indexes, new Set(), signal);
  }

  private require(id: string): PluginRecord { const value = this.records.get(id); if (!value) throw new Error(`未安装插件: ${id}`); return value; }
  private async installWithDependencies(entry: MarketplaceEntry, index: MarketplaceIndex, indexes: readonly string[], visiting: Set<string>, signal?: AbortSignal): Promise<PluginRecord> {
    if (visiting.has(entry.manifest.id)) throw new Error(`插件依赖存在循环: ${[...visiting, entry.manifest.id].join(" -> ")}`);
    visiting.add(entry.manifest.id);
    const document = await this.marketplace.fetchDocument(entry.url, signal);
    for (const [dependency, range] of Object.entries(document.manifest.dependencies ?? {})) {
      const installed = this.records.get(dependency)?.activeVersion;
      if (installed && semver.satisfies(installed, range)) continue;
      const candidates = await index.search(indexes, dependency, signal); const resolved = index.resolve(candidates, dependency, range);
      if (!resolved) throw new Error(`缺少插件依赖: ${dependency}@${range}`);
      await this.installWithDependencies(resolved, index, indexes, new Set(visiting), signal);
    }
    visiting.delete(entry.manifest.id);
    return this.installDocument(document);
  }
  private validateRuntime(manifest: PluginManifest): void {
    if (!semver.valid(manifest.version)) throw new Error(`插件 ${manifest.id} 版本不是有效 semver: ${manifest.version}`);
    if (manifest.products?.length && !manifest.products.some((product) => (this.capabilities.products ?? ["minimal-swe-agent"]).includes(product))) throw new Error(`插件 ${manifest.id} 不支持当前 product`);
    const permissions = new Set(this.capabilities.permissions ?? []);
    const missing = (manifest.requiredPermissions ?? []).filter((permission) => !permissions.has(permission));
    if (missing.length) throw new Error(`插件 ${manifest.id} 缺少运行权限: ${missing.join(", ")}`);
  }
  private async persist(): Promise<void> { await fs.mkdir(path.dirname(this.registryPath), { recursive: true }); const temp = `${this.registryPath}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(Object.fromEntries(this.records), null, 2), "utf8"); await fs.rename(temp, this.registryPath); }
  private async atomicInstall(document: MarketplaceDocument, root: string): Promise<void> {
    const parent = path.dirname(root); await fs.mkdir(parent, { recursive: true }); const staging = await fs.mkdtemp(path.join(parent, ".staging-")); const backup = `${root}.backup-${process.pid}`;
    try {
      for (const [relative, content] of Object.entries(document.files)) {
        const resolved = path.resolve(staging, relative);
        const relation = path.relative(staging, resolved);
        if (!relative || path.isAbsolute(relative) || relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`插件文件路径非法: ${relative}`);
        const target = path.resolve(staging, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, "utf8");
      }
      if (document.manifest.contentHash && contentHashForFiles(document.files) !== document.manifest.contentHash) throw new Error("插件 contentHash 校验失败");
      await fs.writeFile(path.join(staging, "plugin.json"), JSON.stringify(document.manifest, null, 2), "utf8");
      let replaced = false;
      try { await fs.rename(root, backup); replaced = true; } catch (error) { if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error; }
      try { await fs.rename(staging, root); if (replaced) await fs.rm(backup, { recursive: true, force: true }); }
      catch (error) { if (replaced) await fs.rename(backup, root).catch(() => undefined); throw error; }
    } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
  }
}

async function readManifest(root: string): Promise<PluginManifest> {
  const parsed = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error(`插件 manifest 无效: ${root}`);
  return parsed as PluginManifest;
}
async function readJsonFiles(root: string, paths: readonly string[], label: string): Promise<unknown[]> {
  const values: unknown[] = [];
  for (const relative of paths) {
    const target = await containedPluginPath(root, relative, label);
    values.push(JSON.parse(await fs.readFile(target, "utf8")) as unknown);
  }
  return values;
}
async function readHooks(root: string, paths: readonly string[], label: string): Promise<HookConfig[]> {
  const result: HookConfig[] = [];
  for (const value of await readJsonFiles(root, paths, label)) {
    const rows = Array.isArray(value) ? value : [value];
    for (const row of rows) {
      if (!row || typeof row !== "object") throw new Error(`${label} Hook descriptor 无效`);
      const item = row as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.event !== "string" || typeof item.command !== "string") throw new Error(`${label} Hook descriptor 缺少 id/event/command`);
      if (!["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "PermissionRequest", "Interrupt", "Stop", "SubagentStart", "SubagentStop"].includes(item.event)) throw new Error(`${label} Hook event 无效: ${item.event}`);
      result.push({ id: `${label}:${item.id}`, event: item.event as HookConfig["event"], command: await resolvePluginCommand(root, item.command, label), ...(Array.isArray(item.args) ? { args: item.args.filter((arg): arg is string => typeof arg === "string") } : {}), ...(typeof item.matcher === "string" ? { matcher: item.matcher } : {}), ...(typeof item.timeoutMs === "number" ? { timeoutMs: item.timeoutMs } : {}), onTimeout: item.onTimeout === "allow" ? "allow" : "block", onError: item.onError === "allow" ? "allow" : "block" });
    }
  }
  return result;
}
async function readMcpServers(root: string, paths: readonly string[], label: string): Promise<Record<string, SkillMcpServerConfig>> {
  const result: Record<string, SkillMcpServerConfig> = {};
  for (const value of await readJsonFiles(root, paths, label)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} MCP descriptor 无效`);
    for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} MCP ${id} descriptor 无效`);
      const server = raw as Record<string, unknown>;
      if (server.transport !== "stdio" && server.transport !== "http") throw new Error(`${label} MCP ${id} transport 无效`);
      const command = typeof server.command === "string" ? await resolvePluginCommand(root, server.command, label) : undefined;
      const cwd = typeof server.cwd === "string" ? await containedPluginPath(root, server.cwd, label) : undefined;
      const runtimeId = `${label.split("@")[0]}.${id}`;
      result[runtimeId] = { transport: server.transport, enabled: server.enabled !== false, ...(command ? { command } : {}), ...(Array.isArray(server.args) ? { args: server.args.filter((arg): arg is string => typeof arg === "string") } : {}), ...(typeof server.url === "string" ? { url: server.url } : {}), ...(cwd ? { cwd } : {}), ...(server.env && typeof server.env === "object" ? { env: server.env as Record<string, string> } : {}) };
    }
  }
  return result;
}
async function resolvePluginCommand(root: string, command: string, label: string): Promise<string> {
  return command.startsWith(".") || command.includes("/") || command.includes("\\") ? containedPluginPath(root, command, label) : command;
}
async function readScripts(root: string, paths: readonly string[], pluginId: string): Promise<SkillScriptDefinition[]> {
  const result: SkillScriptDefinition[] = [];
  for (const value of await readJsonFiles(root, paths, pluginId)) {
    const rows = Array.isArray(value) ? value : [value];
    for (const row of rows) {
      if (!row || typeof row !== "object") throw new Error(`${pluginId} tool descriptor 无效`);
      const item = row as Record<string, unknown>;
      if (typeof item.name !== "string" || typeof item.description !== "string" || typeof item.script !== "string") throw new Error(`${pluginId} tool descriptor 缺少 name/description/script`);
      const scriptPath = await containedPluginPath(root, item.script, pluginId);
      result.push({ skillId: `plugin.${pluginId}`, name: item.name, description: item.description, scriptPath, cwd: root, args: Array.isArray(item.args) ? item.args.filter((arg): arg is string => typeof arg === "string") : [], ...(item.parameters && typeof item.parameters === "object" ? { parameters: item.parameters as SkillScriptDefinition["parameters"] } : {}), readOnly: item.readOnly === true });
    }
  }
  return result;
}
async function containedPluginPath(root: string, relative: string, label: string): Promise<string> {
  if (!relative || path.isAbsolute(relative)) throw new Error(`${label} 路径越出插件目录: ${relative}`);
  const rootReal = await fs.realpath(root);
  const target = path.resolve(root, relative);
  const relation = path.relative(root, target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`${label} 路径越出插件目录: ${relative}`);
  const targetReal = await fs.realpath(target);
  const realRelation = path.relative(rootReal, targetReal);
  if (realRelation.startsWith("..") || path.isAbsolute(realRelation)) throw new Error(`${label} 符号链接越出插件目录: ${relative}`);
  return targetReal;
}
