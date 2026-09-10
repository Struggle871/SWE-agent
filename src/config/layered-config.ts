import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, AgentsConfig, CompactionConfig, SkillsConfig, HookConfig, HookEventName } from "../types.js";
import { ScopedContextFileSystem, type ContextFileSystem } from "./context-filesystem.js";
import { parseToml } from "./toml.js";

export type ConfigLayerKind = "packaged_defaults" | "system" | "enterprise_managed" | "user" | "profile" | "project" | "env_compat" | "session_flags";
export type ConfigDisabledReason = "untrusted_project" | "outside_workspace" | "policy";
export type AgentConfigPatch = Partial<Omit<AgentConfig, "model" | "agents" | "skills" | "hooks">> & {
  model?: Partial<AgentConfig["model"]>;
  agents?: Partial<AgentsConfig>;
  skills?: Partial<SkillsConfig>;
  hooks?: HookConfig[];
};

export interface ConfigDiagnostic {
  severity: "warning" | "error";
  code: string;
  message: string;
  sourcePath?: string;
  dottedPath?: string;
}

export interface ManagedRequirements {
  allowedSandboxModes?: readonly NonNullable<AgentConfig["sandboxMode"]>[];
  networkCeiling?: NonNullable<AgentConfig["networkAccess"]>;
  fingerprint: string;
}

export interface ConfigLayerEntry {
  id: string;
  kind: ConfigLayerKind;
  sourcePath?: string;
  baseDirectory: string;
  values: Readonly<AgentConfigPatch>;
  version: string;
  disabledReason?: ConfigDisabledReason;
  diagnostics: readonly ConfigDiagnostic[];
}

export interface ConfigOrigin {
  dottedPath: string;
  layerId: string;
  sourcePath?: string;
  version: string;
}

export interface ConfigLayerStack {
  layers: readonly ConfigLayerEntry[];
  effective: AgentConfig;
  origins: ReadonlyMap<string, ConfigOrigin>;
  requirements: ManagedRequirements;
  fingerprint: string;
  diagnostics: readonly ConfigDiagnostic[];
  projectRoot: string;
  projectTrusted: boolean;
}

export interface ConfigLoadOptions {
  cwd?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  userConfigPath?: string | null;
  systemConfigPath?: string | null;
  enterpriseConfigPath?: string | null;
  profileConfigPath?: string | null;
  requirementsPath?: string | null;
  projectTrusted?: boolean;
  fileSystem?: ContextFileSystem;
}

export interface ConfigExplanation {
  dottedPath: string;
  value: unknown;
  origin?: ConfigOrigin;
  history: readonly { layerId: string; sourcePath?: string; value: unknown; disabledReason?: ConfigDisabledReason }[];
  requirements: readonly string[];
}

export async function loadLayeredConfig(overrides: AgentConfigPatch = {}, options: ConfigLoadOptions = {}): Promise<AgentConfig> {
  return loadConfigLayerStack(overrides, options).effective;
}

export function loadConfigLayerStack(overrides: AgentConfigPatch = {}, options: ConfigLoadOptions = {}): ConfigLayerStack {
  const env = options.env ?? process.env;
  const initialCwd = path.resolve(options.cwd ?? overrides.workspaceRoot ?? env.WORKSPACE_ROOT ?? process.cwd());
  const builtin = makeLayer("builtin", "packaged_defaults", initialCwd, builtinConfig(initialCwd));
  const layers: ConfigLayerEntry[] = [builtin];

  pushOptionalLayer(layers, options.systemConfigPath, "system", options.fileSystem);
  pushOptionalLayer(layers, options.enterpriseConfigPath, "enterprise_managed", options.fileSystem);

  const userPath = options.userConfigPath === undefined
    ? path.join(os.homedir(), ".swe-agent", "config.toml")
    : options.userConfigPath;
  if (userPath && isFile(userPath, options.fileSystem)) layers.push(readLayer(userPath, "user", options.fileSystem));
  pushOptionalLayer(layers, options.profileConfigPath, "profile", options.fileSystem);

  const discoveryPatch = normalizePatch(overrides, initialCwd);
  const preProject = mergeLayers([
    ...layers,
    ...(hasValues(discoveryPatch) ? [makeLayer("discovery-session", "session_flags", initialCwd, discoveryPatch)] : []),
  ]);
  const projectRoot = findProjectRoot(initialCwd, preProject.agents?.projectRootMarkers, options.fileSystem);
  const projectTrusted = options.projectTrusted ?? preProject.agents?.projectTrusted ?? true;
  for (const file of projectConfigPaths(projectRoot, initialCwd, options.fileSystem)) {
    layers.push(projectTrusted ? readLayer(file, "project", options.fileSystem) : disabledProjectLayer(file));
  }

  const envPatch = explicitEnvPatch(env);
  if (hasValues(envPatch)) layers.push(makeLayer("env-compat", "env_compat", initialCwd, envPatch));
  if (hasValues(overrides)) layers.push(makeLayer("session-flags", "session_flags", initialCwd, normalizePatch(overrides, initialCwd)));

  const requirements = readRequirements(
    options.requirementsPath === undefined ? path.join(projectRoot, ".swe-agent", "requirements.toml") : options.requirementsPath,
    projectTrusted || options.requirementsPath !== undefined,
    options.fileSystem,
  );
  const effective = mergeLayers(layers);
  validateEffective(effective);
  enforceRequirements(effective, requirements);
  const origins = computeOrigins(layers);
  const diagnostics = layers.flatMap((layer) => layer.diagnostics);
  const fingerprintValueHash = hash({
    schema: 2,
    layers: layers.map(({ id, kind, sourcePath, version, disabledReason }) => ({ id, kind, sourcePath, version, disabledReason })),
    origins: [...origins],
    requirements: requirements.fingerprint,
    projectRoot,
    projectTrusted,
  });
  effective.configFingerprint = fingerprintValueHash;
  effective.requirementsFingerprint = requirements.fingerprint;
  return Object.freeze({
    layers: Object.freeze(layers), effective, origins, requirements, fingerprint: fingerprintValueHash,
    diagnostics: Object.freeze(diagnostics), projectRoot, projectTrusted,
  });
}

export function configExplain(stack: ConfigLayerStack, dottedPath: string): ConfigExplanation {
  const history: Array<ConfigExplanation["history"][number]> = [];
  for (const layer of stack.layers) {
    const value = valueAtPath(layer.values, dottedPath);
    if (value !== undefined || layer.disabledReason) {
      history.push({
        layerId: layer.id,
        ...(layer.sourcePath ? { sourcePath: layer.sourcePath } : {}),
        value: redact(dottedPath, value),
        ...(layer.disabledReason ? { disabledReason: layer.disabledReason } : {}),
      });
    }
  }
  const requirements: string[] = [];
  if (dottedPath === "sandboxMode" && stack.requirements.allowedSandboxModes) requirements.push(`allowed: ${stack.requirements.allowedSandboxModes.join(", ")}`);
  if (dottedPath === "networkAccess" && stack.requirements.networkCeiling) requirements.push(`ceiling: ${stack.requirements.networkCeiling}`);
  return {
    dottedPath,
    value: redact(dottedPath, valueAtPath(stack.effective, dottedPath)),
    ...(stack.origins.get(dottedPath) ? { origin: stack.origins.get(dottedPath) } : {}),
    history,
    requirements,
  };
}

function builtinConfig(root: string): AgentConfigPatch {
  return {
    maxSteps: 20, maxContextTokens: 8_000, maxOutputTokens: 2_048, toolTimeoutMs: 30_000, parseRetry: 2,
    workspaceRoot: root,
    model: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7-flash" },
    useFakeModel: true,
    useLlmPlanning: false,
    hooks: [],
    sandboxMode: process.platform === "win32" ? "docker" : "unavailable",
    networkAccess: "deny",
    agents: { maxBytes: 32 * 1_024, projectRootMarkers: [".git"], fallbackFilenames: [], projectTrusted: true },
    skills: {
      userRoots: [path.join(os.homedir(), ".agents", "skills"), path.join(os.homedir(), ".codex", "skills")],
      includeCodexCompatibilityRoot: true,
      maxSelectedBodyTokensPerSkill: 8_000,
      maxSelectedBodyTokensTotal: 16_000,
      maxScanDepth: 6,
      maxEntriesPerRoot: 20_000,
      maxSkills: 2_000,
      implicitSelection: false,
      selectorThreshold: 0.5,
      selectorMaxResults: 1,
      pluginRoots: [path.join(os.homedir(), ".agents", "plugins")],
      installRoot: path.join(os.homedir(), ".agents", "plugins"),
      marketplaceRequireHash: true,
      scanConcurrency: 8,
      cacheTtlMs: 5_000,
      selectorMode: "explicit",
      embeddingTimeoutMs: 15_000,
      products: ["minimal-swe-agent"],
      marketplaceIndexes: [],
      mcpServers: {},
      remoteProviders: {},
      watch: false,
    },
  };
}

function readLayer(
  file: string,
  kind: Exclude<ConfigLayerKind, "packaged_defaults" | "env_compat" | "session_flags">,
  fileSystem?: ContextFileSystem,
): ConfigLayerEntry {
  const absolute = path.resolve(file);
  const io = fileSystemFor(absolute, fileSystem);
  const canonicalPath = io.realpath(absolute);
  const raw = io.readText(canonicalPath);
  const baseDirectory = path.dirname(canonicalPath);
  const values = tomlToConfig(parseToml(raw), canonicalPath, baseDirectory);
  if (kind === "project") validateProjectPatch(values, canonicalPath);
  return makeLayer(`${kind}:${canonicalPath}`, kind, baseDirectory, values, canonicalPath, raw);
}

function pushOptionalLayer(
  layers: ConfigLayerEntry[],
  file: string | null | undefined,
  kind: "system" | "enterprise_managed" | "profile",
  fileSystem?: ContextFileSystem,
): void {
  if (file && isFile(file, fileSystem)) layers.push(readLayer(file, kind, fileSystem));
}

function validateProjectPatch(values: AgentConfigPatch, source: string): void {
  if (values.workspaceRoot !== undefined || values.agents !== undefined) {
    throw new Error(`${source}: project config 不能设置 workspace root、trust 或 AGENTS discovery`);
  }
  if (values.skills?.userRoots !== undefined || values.skills?.systemRoots !== undefined || values.skills?.adminRoots !== undefined || values.skills?.enablement !== undefined
    || values.skills?.pluginRoots !== undefined || values.skills?.installRoot !== undefined || values.skills?.marketplaceIndexes !== undefined || values.skills?.mcpServers !== undefined || values.skills?.remoteProviders !== undefined) {
    throw new Error(`${source}: project config 不能设置 non-project skill roots、provider、marketplace 或 enablement`);
  }
}

function disabledProjectLayer(file: string): ConfigLayerEntry {
  const absolute = path.resolve(file);
  const diagnostic: ConfigDiagnostic = {
    severity: "warning", code: "untrusted_project_config", message: "项目未受信任，配置层未生效", sourcePath: absolute,
  };
  return {
    id: `project:${absolute}`, kind: "project", sourcePath: absolute, baseDirectory: path.dirname(absolute),
    values: {}, version: hash({ sourcePath: absolute, disabledReason: "untrusted_project" }), disabledReason: "untrusted_project", diagnostics: [diagnostic],
  };
}

function makeLayer(id: string, kind: ConfigLayerKind, baseDirectory: string, values: AgentConfigPatch, sourcePath?: string, raw?: string): ConfigLayerEntry {
  return {
    id, kind, baseDirectory: path.resolve(baseDirectory), values,
    ...(sourcePath ? { sourcePath } : {}),
    version: hash({ sourcePath, raw: raw ?? values }), diagnostics: [],
  };
}

function tomlToConfig(parsed: Record<string, unknown>, source: string, baseDirectory: string): AgentConfigPatch {
  assertKnown(parsed, [
    "max_steps", "max_context_tokens", "max_output_tokens", "tool_timeout_ms", "parse_retry", "workspace_root",
    "use_fake_model", "use_llm_planning", "sandbox_mode", "network_access", "model", "compaction", "agents", "skills", "hooks",
  ], source);
  const out: AgentConfigPatch = {};
  assignNumber(parsed, "max_steps", out, "maxSteps", source);
  assignNumber(parsed, "max_context_tokens", out, "maxContextTokens", source);
  assignNumber(parsed, "max_output_tokens", out, "maxOutputTokens", source);
  assignNumber(parsed, "tool_timeout_ms", out, "toolTimeoutMs", source);
  assignNumber(parsed, "parse_retry", out, "parseRetry", source);
  assignBoolean(parsed, "use_fake_model", out, "useFakeModel", source);
  assignBoolean(parsed, "use_llm_planning", out, "useLlmPlanning", source);
  if (parsed.workspace_root !== undefined) out.workspaceRoot = resolveString(parsed.workspace_root, "workspace_root", source, baseDirectory);
  if (parsed.sandbox_mode !== undefined) out.sandboxMode = enumValue(parsed.sandbox_mode, ["unavailable", "best-effort", "docker"], "sandbox_mode", source);
  if (parsed.network_access !== undefined) out.networkAccess = enumValue(parsed.network_access, ["deny", "allow"], "network_access", source);
  if (parsed.model !== undefined) out.model = parseModel(recordValue(parsed.model, "model", source), source);
  if (parsed.compaction !== undefined) out.compaction = parseCompaction(recordValue(parsed.compaction, "compaction", source), source);
  if (parsed.agents !== undefined) out.agents = parseAgents(recordValue(parsed.agents, "agents", source), source);
  if (parsed.skills !== undefined) out.skills = parseSkills(recordValue(parsed.skills, "skills", source), source, baseDirectory);
  if (parsed.hooks !== undefined) out.hooks = parseHooks(parsed.hooks, source);
  return out;
}

function parseHooks(value: unknown, source: string): HookConfig[] {
  if (!Array.isArray(value)) throw new Error(`${source}: hooks 必须是数组`);
  return value.map((raw, index) => {
    const hook = recordValue(raw, `hooks[${index}]`, source);
    assertKnown(hook, ["id", "event", "command", "args", "matcher", "timeout_ms", "on_timeout", "on_error", "trusted_hash"], `${source}: hooks[${index}]`);
    return {
      id: stringValue(hook.id, `hooks[${index}].id`, source),
      event: enumValue(hook.event, ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "PermissionRequest", "Interrupt", "Stop", "SubagentStart", "SubagentStop"] satisfies readonly HookEventName[], `hooks[${index}].event`, source),
      command: stringValue(hook.command, `hooks[${index}].command`, source),
      ...(hook.args !== undefined ? { args: stringArray(hook.args, `hooks[${index}].args`, source) } : {}),
      ...(hook.matcher !== undefined ? { matcher: stringValue(hook.matcher, `hooks[${index}].matcher`, source) } : {}),
      ...(hook.timeout_ms !== undefined ? { timeoutMs: finiteNumber(hook.timeout_ms, `hooks[${index}].timeout_ms`, source) } : {}),
      ...(hook.on_timeout !== undefined ? { onTimeout: enumValue(hook.on_timeout, ["allow", "block"], `hooks[${index}].on_timeout`, source) } : {}),
      ...(hook.on_error !== undefined ? { onError: enumValue(hook.on_error, ["allow", "block"], `hooks[${index}].on_error`, source) } : {}),
      ...(hook.trusted_hash !== undefined ? { trustedHash: stringValue(hook.trusted_hash, `hooks[${index}].trusted_hash`, source) } : {}),
    };
  });
}

function parseModel(value: Record<string, unknown>, source: string): Partial<AgentConfig["model"]> {
  assertKnown(value, ["base_url", "api_key", "model", "input_cost_per_1k", "output_cost_per_1k"], `${source}: model`);
  const result: Partial<AgentConfig["model"]> = {};
  if (value.base_url !== undefined) result.baseUrl = stringValue(value.base_url, "model.base_url", source);
  if (value.api_key !== undefined) result.apiKey = stringValue(value.api_key, "model.api_key", source);
  if (value.model !== undefined) result.model = stringValue(value.model, "model.model", source);
  if (value.input_cost_per_1k !== undefined) result.inputCostPer1k = finiteNumber(value.input_cost_per_1k, "model.input_cost_per_1k", source);
  if (value.output_cost_per_1k !== undefined) result.outputCostPer1k = finiteNumber(value.output_cost_per_1k, "model.output_cost_per_1k", source);
  return result;
}

function parseCompaction(value: Record<string, unknown>, source: string): Partial<CompactionConfig> {
  const mapping: Record<string, keyof CompactionConfig> = {
    backend: "backend", auto_compact_token_limit: "autoCompactTokenLimit", limit_scope: "limitScope",
    fallback_buffer_tokens: "fallbackBufferTokens", timeout_ms: "timeoutMs", max_retries: "maxRetries",
    max_retained_user_tokens: "maxRetainedUserTokens", max_checkpoint_items: "maxCheckpointItems",
    max_checkpoint_bytes: "maxCheckpointBytes", max_item_bytes: "maxItemBytes", prompt: "prompt",
  };
  assertKnown(value, Object.keys(mapping), `${source}: compaction`);
  const result: Record<string, unknown> = {};
  for (const [key, target] of Object.entries(mapping)) {
    if (value[key] === undefined) continue;
    if (key === "backend") result[target] = enumValue(value[key], ["auto", "local", "remote", "remote_v2", "new_context"], `compaction.${key}`, source);
    else if (key === "limit_scope") result[target] = enumValue(value[key], ["total", "body_after_prefix"], `compaction.${key}`, source);
    else if (key === "prompt") result[target] = stringValue(value[key], `compaction.${key}`, source);
    else result[target] = finiteNumber(value[key], `compaction.${key}`, source);
  }
  return result as Partial<CompactionConfig>;
}

function parseAgents(value: Record<string, unknown>, source: string): Partial<AgentsConfig> {
  assertKnown(value, ["fallback_filenames", "project_root_markers", "max_bytes", "project_trusted"], `${source}: agents`);
  return {
    ...(value.fallback_filenames !== undefined ? { fallbackFilenames: safeFilenames(value.fallback_filenames, "agents.fallback_filenames", source) } : {}),
    ...(value.project_root_markers !== undefined ? { projectRootMarkers: safeFilenames(value.project_root_markers, "agents.project_root_markers", source) } : {}),
    ...(value.max_bytes !== undefined ? { maxBytes: finiteNumber(value.max_bytes, "agents.max_bytes", source) } : {}),
    ...(value.project_trusted !== undefined ? { projectTrusted: booleanValue(value.project_trusted, "agents.project_trusted", source) } : {}),
  };
}

function parseSkills(value: Record<string, unknown>, source: string, baseDirectory: string): Partial<SkillsConfig> {
  assertKnown(value, [
    "repo_roots", "user_roots", "system_roots", "admin_roots", "max_context_tokens", "max_selected_body_tokens_per_skill",
    "max_selected_body_tokens_total", "enablement", "include_codex_compatibility_root", "max_scan_depth",
     "max_entries_per_root", "max_skills", "implicit_selection", "selector_threshold", "selector_max_results",
     "plugin_roots", "install_root", "marketplace_require_hash", "watch", "scan_concurrency", "cache_ttl_ms",
     "selector_mode", "embedding_model", "embedding_base_url", "embedding_api_key", "embedding_timeout_ms",
     "products", "marketplace_indexes", "mcp_servers", "remote_providers",
  ], `${source}: skills`);
  const result: Partial<SkillsConfig> = {};
  if (value.repo_roots !== undefined) result.repoRoots = pathList(value.repo_roots, "skills.repo_roots", source, baseDirectory);
  if (value.user_roots !== undefined) result.userRoots = pathList(value.user_roots, "skills.user_roots", source, baseDirectory);
  if (value.system_roots !== undefined) result.systemRoots = pathList(value.system_roots, "skills.system_roots", source, baseDirectory);
  if (value.admin_roots !== undefined) result.adminRoots = pathList(value.admin_roots, "skills.admin_roots", source, baseDirectory);
  if (value.max_context_tokens !== undefined) result.maxContextTokens = finiteNumber(value.max_context_tokens, "skills.max_context_tokens", source);
  if (value.max_selected_body_tokens_per_skill !== undefined) result.maxSelectedBodyTokensPerSkill = finiteNumber(value.max_selected_body_tokens_per_skill, "skills.max_selected_body_tokens_per_skill", source);
  if (value.max_selected_body_tokens_total !== undefined) result.maxSelectedBodyTokensTotal = finiteNumber(value.max_selected_body_tokens_total, "skills.max_selected_body_tokens_total", source);
  if (value.include_codex_compatibility_root !== undefined) result.includeCodexCompatibilityRoot = booleanValue(value.include_codex_compatibility_root, "skills.include_codex_compatibility_root", source);
  if (value.max_scan_depth !== undefined) result.maxScanDepth = finiteNumber(value.max_scan_depth, "skills.max_scan_depth", source);
  if (value.max_entries_per_root !== undefined) result.maxEntriesPerRoot = finiteNumber(value.max_entries_per_root, "skills.max_entries_per_root", source);
  if (value.max_skills !== undefined) result.maxSkills = finiteNumber(value.max_skills, "skills.max_skills", source);
  if (value.implicit_selection !== undefined) result.implicitSelection = booleanValue(value.implicit_selection, "skills.implicit_selection", source);
  if (value.selector_threshold !== undefined) result.selectorThreshold = finiteNumber(value.selector_threshold, "skills.selector_threshold", source);
  if (value.selector_max_results !== undefined) result.selectorMaxResults = finiteNumber(value.selector_max_results, "skills.selector_max_results", source);
  if (value.plugin_roots !== undefined) result.pluginRoots = pathList(value.plugin_roots, "skills.plugin_roots", source, baseDirectory);
  if (value.install_root !== undefined) result.installRoot = resolveString(value.install_root, "skills.install_root", source, baseDirectory);
  if (value.marketplace_require_hash !== undefined) result.marketplaceRequireHash = booleanValue(value.marketplace_require_hash, "skills.marketplace_require_hash", source);
  if (value.watch !== undefined) result.watch = booleanValue(value.watch, "skills.watch", source);
  if (value.scan_concurrency !== undefined) result.scanConcurrency = finiteNumber(value.scan_concurrency, "skills.scan_concurrency", source);
  if (value.cache_ttl_ms !== undefined) result.cacheTtlMs = finiteNumber(value.cache_ttl_ms, "skills.cache_ttl_ms", source);
  if (value.selector_mode !== undefined) result.selectorMode = enumValue(value.selector_mode, ["explicit", "lexical", "embedding", "hybrid"], "skills.selector_mode", source);
  if (value.embedding_model !== undefined) result.embeddingModel = stringValue(value.embedding_model, "skills.embedding_model", source);
  if (value.embedding_base_url !== undefined) result.embeddingBaseUrl = stringValue(value.embedding_base_url, "skills.embedding_base_url", source);
  if (value.embedding_api_key !== undefined) result.embeddingApiKey = stringValue(value.embedding_api_key, "skills.embedding_api_key", source);
  if (value.embedding_timeout_ms !== undefined) result.embeddingTimeoutMs = finiteNumber(value.embedding_timeout_ms, "skills.embedding_timeout_ms", source);
  if (value.products !== undefined) result.products = stringArray(value.products, "skills.products", source);
  if (value.marketplace_indexes !== undefined) result.marketplaceIndexes = stringArray(value.marketplace_indexes, "skills.marketplace_indexes", source);
  if (value.mcp_servers !== undefined) result.mcpServers = parseMcpServers(recordValue(value.mcp_servers, "skills.mcp_servers", source), source, baseDirectory);
  if (value.remote_providers !== undefined) result.remoteProviders = parseRemoteProviders(recordValue(value.remote_providers, "skills.remote_providers", source), source);
  if (value.enablement !== undefined) {
    const rules = recordValue(value.enablement, "skills.enablement", source);
    result.enablement = Object.fromEntries(Object.entries(rules).map(([key, enabled]) => [key, booleanValue(enabled, `skills.enablement.${key}`, source)]));
  }
  return result;
}

function parseRemoteProviders(value: Record<string, unknown>, source: string): NonNullable<SkillsConfig["remoteProviders"]> {
  return Object.fromEntries(Object.entries(value).map(([id, raw]) => {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`${source}: remote provider id 无效: ${id}`);
    const provider = recordValue(raw, `skills.remote_providers.${id}`, source);
    assertKnown(provider, ["enabled", "kind", "base_url", "api_key", "timeout_ms"], `${source}: skills.remote_providers.${id}`);
    return [id, {
      kind: enumValue(provider.kind, ["executor", "orchestrator"], `skills.remote_providers.${id}.kind`, source),
      baseUrl: stringValue(provider.base_url, `skills.remote_providers.${id}.base_url`, source),
      ...(provider.enabled !== undefined ? { enabled: booleanValue(provider.enabled, `skills.remote_providers.${id}.enabled`, source) } : {}),
      ...(provider.api_key !== undefined ? { apiKey: stringValue(provider.api_key, `skills.remote_providers.${id}.api_key`, source) } : {}),
      ...(provider.timeout_ms !== undefined ? { timeoutMs: finiteNumber(provider.timeout_ms, `skills.remote_providers.${id}.timeout_ms`, source) } : {}),
    }];
  }));
}

function parseMcpServers(value: Record<string, unknown>, source: string, baseDirectory: string): NonNullable<SkillsConfig["mcpServers"]> {
  return Object.fromEntries(Object.entries(value).map(([id, raw]) => {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`${source}: MCP server id 无效: ${id}`);
    const server = recordValue(raw, `skills.mcp_servers.${id}`, source);
    assertKnown(server, ["enabled", "transport", "command", "args", "cwd", "env", "url", "headers", "timeout_ms", "resource_prefixes", "oauth"], `${source}: skills.mcp_servers.${id}`);
    const transport = enumValue(server.transport, ["stdio", "http"], `skills.mcp_servers.${id}.transport`, source);
    const env = server.env === undefined ? undefined : stringMap(server.env, `skills.mcp_servers.${id}.env`, source);
    const headers = server.headers === undefined ? undefined : stringMap(server.headers, `skills.mcp_servers.${id}.headers`, source);
    const result: import("../types.js").SkillMcpServerConfig = {
      transport,
      ...(server.enabled !== undefined ? { enabled: booleanValue(server.enabled, `skills.mcp_servers.${id}.enabled`, source) } : {}),
      ...(server.command !== undefined ? { command: stringValue(server.command, `skills.mcp_servers.${id}.command`, source) } : {}),
      ...(server.args !== undefined ? { args: stringArray(server.args, `skills.mcp_servers.${id}.args`, source) } : {}),
      ...(server.cwd !== undefined ? { cwd: resolveString(server.cwd, `skills.mcp_servers.${id}.cwd`, source, baseDirectory) } : {}),
      ...(env ? { env } : {}), ...(headers ? { headers } : {}),
      ...(server.url !== undefined ? { url: stringValue(server.url, `skills.mcp_servers.${id}.url`, source) } : {}),
      ...(server.timeout_ms !== undefined ? { timeoutMs: finiteNumber(server.timeout_ms, `skills.mcp_servers.${id}.timeout_ms`, source) } : {}),
      ...(server.resource_prefixes !== undefined ? { resourcePrefixes: stringArray(server.resource_prefixes, `skills.mcp_servers.${id}.resource_prefixes`, source) } : {}),
      ...(server.oauth !== undefined ? { oauth: parseMcpOAuth(recordValue(server.oauth, `skills.mcp_servers.${id}.oauth`, source), `skills.mcp_servers.${id}.oauth`, source) } : {}),
    };
    if (transport === "stdio" && !result.command) throw new Error(`${source}: stdio MCP server ${id} 缺少 command`);
    if (transport === "http" && !result.url) throw new Error(`${source}: HTTP MCP server ${id} 缺少 url`);
    return [id, result];
  }));
}

function parseMcpOAuth(value: Record<string, unknown>, label: string, source: string): NonNullable<import("../types.js").SkillMcpServerConfig["oauth"]> {
  assertKnown(value, ["token_url", "authorization_url", "client_id", "client_secret", "scopes", "grant_type", "redirect_uri"], `${source}: ${label}`);
  const grantType = value.grant_type === undefined ? "client_credentials" : enumValue(value.grant_type, ["client_credentials", "authorization_code"], `${label}.grant_type`, source);
  const clientId = stringValue(value.client_id, `${label}.client_id`, source);
  return {
    clientId,
    grantType,
    ...(value.token_url !== undefined ? { tokenUrl: stringValue(value.token_url, `${label}.token_url`, source) } : {}),
    ...(value.authorization_url !== undefined ? { authorizationUrl: stringValue(value.authorization_url, `${label}.authorization_url`, source) } : {}),
    ...(value.client_secret !== undefined ? { clientSecret: stringValue(value.client_secret, `${label}.client_secret`, source) } : {}),
    ...(value.scopes !== undefined ? { scopes: stringArray(value.scopes, `${label}.scopes`, source) } : {}),
    ...(value.redirect_uri !== undefined ? { redirectUri: stringValue(value.redirect_uri, `${label}.redirect_uri`, source) } : {}),
  };
}

function explicitEnvPatch(env: Readonly<NodeJS.ProcessEnv>): AgentConfigPatch {
  const out: AgentConfigPatch = {};
  assignEnvNumber(env, "MAX_STEPS", out, "maxSteps");
  assignEnvNumber(env, "MAX_CONTEXT_TOKENS", out, "maxContextTokens");
  assignEnvNumber(env, "MAX_OUTPUT_TOKENS", out, "maxOutputTokens");
  assignEnvNumber(env, "TOOL_TIMEOUT_MS", out, "toolTimeoutMs");
  assignEnvNumber(env, "PARSE_RETRY", out, "parseRetry");
  if (env.WORKSPACE_ROOT !== undefined) out.workspaceRoot = path.resolve(env.WORKSPACE_ROOT);
  if (env.MODEL_BASE_URL !== undefined || env.MODEL_NAME !== undefined || env.MODEL_API_KEY !== undefined) {
    out.model = {
      ...(env.MODEL_BASE_URL !== undefined ? { baseUrl: env.MODEL_BASE_URL } : {}),
      ...(env.MODEL_NAME !== undefined ? { model: env.MODEL_NAME } : {}),
      ...(env.MODEL_API_KEY !== undefined ? { apiKey: env.MODEL_API_KEY } : {}),
    };
  }
  if (env.MODEL_API_KEY !== undefined && env.USE_FAKE_MODEL === undefined) out.useFakeModel = false;
  if (env.USE_FAKE_MODEL !== undefined) out.useFakeModel = envBoolean(env.USE_FAKE_MODEL, "USE_FAKE_MODEL");
  if (env.USE_LLM_PLANNING !== undefined) out.useLlmPlanning = envBoolean(env.USE_LLM_PLANNING, "USE_LLM_PLANNING");
  if (env.SWE_SANDBOX_MODE !== undefined) out.sandboxMode = enumValue(env.SWE_SANDBOX_MODE.trim().toLowerCase(), ["unavailable", "best-effort", "docker"], "SWE_SANDBOX_MODE", "environment");
  if (env.SWE_NETWORK_ACCESS !== undefined) out.networkAccess = enumValue(env.SWE_NETWORK_ACCESS.trim().toLowerCase(), ["deny", "allow"], "SWE_NETWORK_ACCESS", "environment");
  return out;
}

function readRequirements(file: string | null, trusted: boolean, fileSystem?: ContextFileSystem): ManagedRequirements {
  if (!file || !trusted || !isFile(file, fileSystem)) return { fingerprint: hash({}) };
  const absolute = path.resolve(file);
  const io = fileSystemFor(absolute, fileSystem);
  const canonicalPath = io.realpath(absolute);
  const parsed = parseToml(io.readText(canonicalPath));
  assertKnown(parsed, ["requirements"], canonicalPath);
  const value = recordValue(parsed.requirements, "requirements", canonicalPath);
  assertKnown(value, ["allowed_sandbox_modes", "network_ceiling"], `${canonicalPath}: requirements`);
  const allowed = value.allowed_sandbox_modes === undefined ? undefined : stringArray(value.allowed_sandbox_modes, "requirements.allowed_sandbox_modes", canonicalPath)
    .map((mode) => enumValue(mode, ["unavailable", "best-effort", "docker"], "requirements.allowed_sandbox_modes", canonicalPath));
  const network = value.network_ceiling === undefined ? undefined : enumValue(value.network_ceiling, ["deny", "allow"], "requirements.network_ceiling", canonicalPath);
  return {
    ...(allowed ? { allowedSandboxModes: allowed } : {}),
    ...(network ? { networkCeiling: network } : {}),
    fingerprint: hash(value),
  };
}

function enforceRequirements(config: AgentConfig, requirements: ManagedRequirements): void {
  if (requirements.allowedSandboxModes && (!config.sandboxMode || !requirements.allowedSandboxModes.includes(config.sandboxMode))) {
    throw new Error(`managed requirement 拒绝 sandboxMode=${config.sandboxMode ?? "undefined"}`);
  }
  if (requirements.networkCeiling === "deny" && config.networkAccess === "allow") throw new Error("managed requirement 拒绝 networkAccess=allow");
}

function mergeLayers(layers: readonly ConfigLayerEntry[]): AgentConfig {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (layer.disabledReason) continue;
    deepMerge(merged, layer.values as Record<string, unknown>);
  }
  return merged as unknown as AgentConfig;
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isRecord(value) && isRecord(target[key])) deepMerge(target[key] as Record<string, unknown>, value);
    else target[key] = structuredClone(value);
  }
}

function computeOrigins(layers: readonly ConfigLayerEntry[]): Map<string, ConfigOrigin> {
  const result = new Map<string, ConfigOrigin>();
  for (const layer of layers) {
    if (layer.disabledReason) continue;
    for (const dottedPath of leafPaths(layer.values)) {
      result.set(dottedPath, { dottedPath, layerId: layer.id, ...(layer.sourcePath ? { sourcePath: layer.sourcePath } : {}), version: layer.version });
    }
  }
  return result;
}

function validateEffective(config: AgentConfig): void {
  for (const [key, value, minimum] of [
    ["maxSteps", config.maxSteps, 1], ["maxContextTokens", config.maxContextTokens, 1],
    ["maxOutputTokens", config.maxOutputTokens, 1], ["toolTimeoutMs", config.toolTimeoutMs, 1], ["parseRetry", config.parseRetry, 0],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum) throw new Error(`配置 ${key} 必须是大于等于 ${minimum} 的整数`);
  }
  if (!config.model?.baseUrl || !config.model.model) throw new Error("配置 model.baseUrl 和 model.model 必填");
  if (!path.isAbsolute(config.workspaceRoot)) throw new Error("配置 workspaceRoot 必须解析为绝对路径");
}

function findProjectRoot(cwd: string, markers: readonly string[] = [".git"], fileSystem?: ContextFileSystem): string {
  let current = path.resolve(cwd);
  for (;;) {
    if (markers.some((marker) => contextExists(path.join(current, marker), fileSystem))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function projectConfigPaths(root: string, cwd: string, fileSystem?: ContextFileSystem): string[] {
  if (!isWithin(root, cwd)) return [];
  const result: string[] = [];
  let current = path.resolve(root);
  const target = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(current, ".swe-agent", "config.toml");
    if (isFile(candidate, fileSystem)) result.push(candidate);
    if (samePath(current, target)) break;
    const relative = path.relative(current, target);
    const next = relative.split(path.sep)[0];
    if (!next || next === "..") break;
    current = path.join(current, next);
  }
  return result;
}

function normalizePatch(patch: AgentConfigPatch, baseDirectory: string): AgentConfigPatch {
  const copy = structuredClone(patch);
  if (copy.workspaceRoot) copy.workspaceRoot = path.resolve(baseDirectory, copy.workspaceRoot);
  if (copy.skills?.repoRoots) copy.skills.repoRoots = copy.skills.repoRoots.map((root) => path.resolve(baseDirectory, root));
  if (copy.skills?.userRoots) copy.skills.userRoots = copy.skills.userRoots.map((root) => path.resolve(baseDirectory, root));
  if (copy.skills?.systemRoots) copy.skills.systemRoots = copy.skills.systemRoots.map((root) => path.resolve(baseDirectory, root));
  if (copy.skills?.adminRoots) copy.skills.adminRoots = copy.skills.adminRoots.map((root) => path.resolve(baseDirectory, root));
  return copy;
}

function valueAtPath(value: unknown, dottedPath: string): unknown {
  let current = value;
  for (const part of dottedPath.split(".")) {
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function leafPaths(value: unknown, prefix = ""): string[] {
  if (!isRecord(value)) return prefix ? [prefix] : [];
  const result: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (isRecord(item)) result.push(...leafPaths(item, dotted));
    else result.push(dotted);
  }
  return result;
}

function redact(dottedPath: string, value: unknown): unknown {
  return /(?:api[_-]?key|token|secret|password|credential)/i.test(dottedPath) && value !== undefined ? "<redacted>" : value;
}

function assignNumber(source: Record<string, unknown>, key: string, target: Record<string, unknown>, targetKey: string, location: string): void {
  if (source[key] !== undefined) target[targetKey] = finiteNumber(source[key], key, location);
}
function assignBoolean(source: Record<string, unknown>, key: string, target: Record<string, unknown>, targetKey: string, location: string): void {
  if (source[key] !== undefined) target[targetKey] = booleanValue(source[key], key, location);
}
function assignEnvNumber(env: Readonly<NodeJS.ProcessEnv>, key: string, target: Record<string, unknown>, targetKey: string): void {
  if (env[key] !== undefined) target[targetKey] = finiteNumber(Number(env[key]), key, "environment");
}
function finiteNumber(value: unknown, key: string, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${source}: ${key} 必须是有限数字`);
  return value;
}
function booleanValue(value: unknown, key: string, source: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${source}: ${key} 必须是布尔值`);
  return value;
}
function envBoolean(value: string, key: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "true" && normalized !== "false") throw new Error(`environment: ${key} 必须是 true 或 false`);
  return normalized === "true";
}
function stringValue(value: unknown, key: string, source: string): string {
  if (typeof value !== "string") throw new Error(`${source}: ${key} 必须是字符串`);
  return value;
}
function resolveString(value: unknown, key: string, source: string, baseDirectory: string): string {
  return path.resolve(baseDirectory, stringValue(value, key, source));
}
function stringArray(value: unknown, key: string, source: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${source}: ${key} 必须是字符串数组`);
  return value;
}
function stringMap(value: unknown, key: string, source: string): Record<string, string> {
  const record = recordValue(value, key, source);
  for (const [name, item] of Object.entries(record)) if (typeof item !== "string") throw new Error(`${source}: ${key}.${name} 必须是字符串`);
  return record as Record<string, string>;
}
function pathList(value: unknown, key: string, source: string, baseDirectory: string): string[] {
  return stringArray(value, key, source).map((item) => path.resolve(baseDirectory, item));
}
function safeFilenames(value: unknown, key: string, source: string): string[] {
  const names = stringArray(value, key, source);
  for (const name of names) {
    if (!name || name === "." || name === ".." || path.isAbsolute(name) || name.includes("/") || name.includes("\\")) throw new Error(`${source}: ${key} 只能包含安全文件名`);
  }
  return [...new Set(names)];
}
function enumValue<const T extends string>(value: unknown, allowed: readonly T[], key: string, source: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${source}: ${key} 必须是 ${allowed.join(" | ")}`);
  return value as T;
}
function recordValue(value: unknown, key: string, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${source}: ${key} 必须是 table`);
  return value;
}
function assertKnown(value: Record<string, unknown>, allowed: readonly string[], source: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`${source} 包含未知字段: ${key}`);
}
function hasValues(value: object): boolean { return Object.keys(value).length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function fileSystemFor(candidate: string, fileSystem?: ContextFileSystem): ContextFileSystem {
  return fileSystem ?? new ScopedContextFileSystem([path.dirname(path.resolve(candidate))]);
}
function contextExists(value: string, fileSystem?: ContextFileSystem): boolean {
  return fileSystemFor(value, fileSystem).exists(value);
}
function isFile(value: string, fileSystem?: ContextFileSystem): boolean {
  return fileSystemFor(value, fileSystem).isFile(value);
}
function hash(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value: unknown): string { return JSON.stringify(sortValue(value)); }
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
function samePath(left: string, right: string): boolean { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
