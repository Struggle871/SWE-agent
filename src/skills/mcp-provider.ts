import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentContext, JsonSchema, ToolResult } from "../types.js";
import type { ToolRegistration } from "../tools/types.js";
import type { SkillMetadata } from "../config/skills.js";
import type { SkillMcpServerConfig } from "../types.js";
import { McpCredentialStore } from "./mcp-credentials.js";
import { McpElicitationBroker } from "./mcp-elicitation.js";
import type { SkillProvider, SkillProviderRequest } from "./platform.js";

export type McpConnectionState = "disconnected" | "connecting" | "ready" | "degraded" | "closed";

export interface McpSkillProviderOptions {
  server: SkillMcpServerConfig;
  timeoutMs?: number;
  resourcePrefixes?: readonly string[];
  credentialStore?: McpCredentialStore;
  elicitationBroker?: McpElicitationBroker;
}

/** A real MCP client-backed Skill provider. One MCP session owns one transport;
 * failures degrade the provider and never leak a child process into the agent. */
export class McpSkillProvider implements SkillProvider {
  readonly kind = "mcp" as const;
  private state: McpConnectionState = "disconnected";
  private client?: Client;
  private transport?: StdioClientTransport | StreamableHTTPClientTransport;
  private skills: readonly SkillMetadata[] = [];
  private tools: readonly { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }[] = [];
  private prompts: readonly { name: string; description: string }[] = [];
  private resourceTemplates: readonly { uriTemplate: string; name: string; description?: string }[] = [];
  readonly elicitationBroker: McpElicitationBroker;
  private activeSignals: AbortSignal[] = [];

  constructor(public readonly id: string, private readonly options: McpSkillProviderOptions) { this.elicitationBroker = options.elicitationBroker ?? new McpElicitationBroker(); }

  get connectionState(): McpConnectionState { return this.state; }
  get status(): { id: string; state: McpConnectionState; tools: number; resources: number; prompts: number; resourceTemplates: number } { return { id: this.id, state: this.state, tools: this.tools.length, resources: this.skills.length, prompts: this.prompts.length, resourceTemplates: this.resourceTemplates.length }; }

  async list(signal?: AbortSignal): Promise<readonly SkillMetadata[]> {
    await this.ensureReady(signal);
    if (!this.client!.getServerCapabilities()?.resources) return [];
    const resources = (await this.listAll("resources", signal)).filter((resource) => this.accepts(resource.uri));
    this.skills = resources.map((resource) => ({
      id: `mcp:${this.id}:${resource.uri}`, name: resource.name, description: resource.description ?? `MCP resource ${resource.uri}`,
      path: resource.uri, canonicalPath: resource.uri, rootPath: `mcp://${this.id}`, scope: "user", enabled: true,
      allowImplicitInvocation: true, body: "", bodyHash: "", diagnostics: [], providerId: this.id,
    }));
    return this.skills;
  }

  async read(locator: string, signal?: AbortSignal): Promise<string> {
    await this.ensureReady(signal);
    const result = await this.withTimeout((requestSignal) => this.client!.readResource({ uri: locator }, { signal: requestSignal }), signal);
    return result.contents.map((content) => "text" in content ? content.text : `[binary MCP resource ${content.uri}]`).join("\n");
  }

  catalog(): { prompts: readonly { name: string; description: string }[]; resourceTemplates: readonly { uriTemplate: string; name: string; description?: string }[] } {
    return { prompts: this.prompts.map((item) => ({ ...item })), resourceTemplates: this.resourceTemplates.map((item) => ({ ...item })) };
  }

  async getPrompt(name: string, args: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    await this.ensureReady(signal);
    if (!this.client!.getServerCapabilities()?.prompts) throw new Error(`MCP provider ${this.id} 不支持 prompts`);
    return this.withTimeout((requestSignal) => this.client!.getPrompt({ name, arguments: args }, { signal: requestSignal }), signal);
  }

  async subscribe(uri: string, signal?: AbortSignal): Promise<void> {
    await this.ensureReady(signal);
    if (!this.client!.getServerCapabilities()?.resources?.subscribe) throw new Error(`MCP provider ${this.id} 不支持 resource subscription`);
    await this.withTimeout((requestSignal) => this.client!.subscribeResource({ uri }, { signal: requestSignal }), signal);
  }

  async unsubscribe(uri: string, signal?: AbortSignal): Promise<void> {
    await this.ensureReady(signal);
    await this.withTimeout((requestSignal) => this.client!.unsubscribeResource({ uri }, { signal: requestSignal }), signal);
  }

  async execute(request: SkillProviderRequest): Promise<ToolResult> {
    try {
      await this.ensureReady(request.signal);
      const toolName = request.locator.startsWith(`${this.id}:`) ? request.locator.slice(this.id.length + 1) : request.locator;
      let result: { content?: unknown; isError?: boolean };
      try {
        result = await this.withTimeout((requestSignal) => this.client!.callTool({ name: toolName, arguments: request.input ?? {} }, undefined, { signal: requestSignal }), request.signal) as { content?: unknown; isError?: boolean };
      } catch (error) {
        await this.reconnect(request.signal).catch(() => undefined);
        result = await this.withTimeout((requestSignal) => this.client!.callTool({ name: toolName, arguments: request.input ?? {} }, undefined, { signal: requestSignal }), request.signal) as { content?: unknown; isError?: boolean };
      }
      const content = Array.isArray(result.content) ? result.content : [];
      const output = content.map((item: unknown) => {
        if (!item || typeof item !== "object") return String(item);
        if ("text" in item && typeof (item as { text?: unknown }).text === "string") return (item as { text: string }).text;
        return `[${String((item as { type?: unknown }).type ?? "content")}]`;
      }).join("\n");
      return { toolName: `skill.${this.id}.${toolName}`, output, isError: result.isError === true };
    } catch (error) {
      return { toolName: `skill.${this.id}`, output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  async registrations(signal?: AbortSignal): Promise<ToolRegistration[]> {
    await this.ensureReady(signal);
    return this.tools.map((tool) => ({
      spec: { name: tool.name, namespace: `mcp.${this.id}`, description: tool.description, parameters: tool.inputSchema as JsonSchema, isReadOnly: tool.readOnly, exposure: "direct" },
      runtime: { execute: (input, _ctx, options) => this.execute({ locator: tool.name, input, signal: options?.signal }) },
      source: `mcp:${this.id}`,
    }));
  }

  async close(): Promise<void> {
    this.state = "closed";
    await this.client?.close().catch(() => undefined);
    this.client = undefined; this.transport = undefined;
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    if (this.state === "closed") throw new Error(`MCP provider ${this.id} 已关闭`);
    if (!this.client) { await this.ensureReady(signal); return; }
    const capabilities = this.client.getServerCapabilities();
    const resources = capabilities?.resources ? await this.listAll("resources", signal) : [];
    const tools = capabilities?.tools ? await this.listAll("tools", signal) : [];
    this.skills = resources.filter((resource) => this.accepts(resource.uri)).map((resource) => ({ id: `mcp:${this.id}:${resource.uri}`, name: resource.name, description: resource.description ?? `MCP resource ${resource.uri}`, path: resource.uri, canonicalPath: resource.uri, rootPath: `mcp://${this.id}`, scope: "user", enabled: true, allowImplicitInvocation: true, body: "", bodyHash: "", diagnostics: [], providerId: this.id }));
    this.tools = tools.map((tool) => ({ name: tool.name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema, readOnly: tool.annotations?.readOnlyHint === true }));
    this.prompts = capabilities?.prompts ? (await this.listAll("prompts", signal)).map((prompt) => ({ name: prompt.name, description: prompt.description ?? prompt.name })) : [];
    this.resourceTemplates = capabilities?.resources ? (await this.listAll("resourceTemplates", signal)).map((template) => ({ uriTemplate: template.uriTemplate, name: template.name, ...(template.description ? { description: template.description } : {}) })) : [];
  }

  private async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.state === "closed") throw new Error(`MCP provider ${this.id} 已关闭`);
    if (this.state === "ready") return;
    this.state = "connecting";
    try {
      await this.client?.close().catch(() => undefined);
      this.client = undefined;
      const server = this.options.server;
      const headers = await this.oauthHeaders(server, signal);
      this.transport = server.transport === "stdio"
        ? new StdioClientTransport({ command: server.command!, args: server.args, cwd: server.cwd, env: filteredMcpEnvironment(server.env), stderr: "pipe" })
        : new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: { ...(server.headers ?? {}), ...headers } } });
      const client = new Client({ name: "minimal-swe-agent", version: "0.1.0" }, { listChanged: {
        tools: { onChanged: () => { void this.refresh().catch(() => { this.state = "degraded"; }); } },
        resources: { onChanged: () => { void this.refresh().catch(() => { this.state = "degraded"; }); } },
        prompts: { onChanged: () => { void this.refresh().catch(() => { this.state = "degraded"; }); } },
      }, capabilities: { elicitation: { form: {}, url: {} } } });
      client.setRequestHandler(ElicitRequestSchema, async (request: ElicitRequest) => {
        const params = request.params;
        return this.elicitationBroker.request(this.id, {
          ...(params.mode ? { mode: params.mode } : {}),
          message: params.message,
          ...(params.mode === "url" ? { url: params.url, elicitationId: params.elicitationId } : { requestedSchema: params.requestedSchema as Record<string, unknown> }),
        }, this.activeSignals.at(-1)) as Promise<unknown> as never;
      });
      await client.connect(this.transport, { signal, timeout: this.options.timeoutMs ?? server.timeoutMs ?? 15_000 });
      this.client = client;
      if (client.getServerCapabilities()?.tools) {
        const toolList = await this.listAll("tools", signal);
        this.tools = toolList.map((tool) => ({ name: String(tool.name), description: String(tool.description ?? tool.name), inputSchema: tool.inputSchema as Record<string, unknown>, readOnly: tool.annotations?.readOnlyHint === true }));
      } else this.tools = [];
      this.prompts = client.getServerCapabilities()?.prompts ? (await this.listAll("prompts", signal)).map((prompt) => ({ name: prompt.name, description: prompt.description ?? prompt.name })) : [];
      this.resourceTemplates = client.getServerCapabilities()?.resources ? (await this.listAll("resourceTemplates", signal)).map((template) => ({ uriTemplate: template.uriTemplate, name: template.name, ...(template.description ? { description: template.description } : {}) })) : [];
      this.state = "ready";
    } catch (error) {
      this.state = "degraded";
      await this.transport?.close().catch(() => undefined);
      this.transport = undefined;
      throw error;
    }
  }

  private async reconnect(signal?: AbortSignal): Promise<void> {
    this.state = "degraded";
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    this.transport = undefined;
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await this.ensureReady(signal); return; }
      catch (error) { last = error; if (attempt < 2) await abortableDelay(50 * 2 ** attempt, signal); }
    }
    throw last ?? new Error(`MCP provider ${this.id} reconnect failed`);
  }

  private async oauthHeaders(server: SkillMcpServerConfig, signal?: AbortSignal): Promise<Record<string, string>> {
    const oauth = server.oauth;
    if (!oauth || server.transport !== "http") return {};
    if (!this.options.credentialStore) throw new Error(`MCP provider ${this.id} 配置 OAuth 但未提供 credential store`);
    const current = await this.options.credentialStore.get(this.id);
    if (current && (!current.expiresAt || current.expiresAt > Date.now() + 30_000)) return { authorization: `${current.tokenType ?? "Bearer"} ${current.accessToken}` };
    if (oauth.grantType === "authorization_code") {
      const refreshed = await this.options.credentialStore.refresh(this.id, oauth, signal);
      if (refreshed) return { authorization: `${refreshed.tokenType ?? "Bearer"} ${refreshed.accessToken}` };
      throw new Error(`MCP provider ${this.id} 尚未完成 authorization-code OAuth，请先执行 mcp.oauth.begin/complete`);
    }
    if (!oauth.clientSecret || !oauth.tokenUrl) throw new Error(`MCP provider ${this.id} OAuth client_credentials 配置不完整，拒绝匿名连接`);
    const clientSecret = oauth.clientSecret;
    const tokenUrl = oauth.tokenUrl;
    const response = await this.withTimeout((requestSignal) => fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: oauth.clientId, client_secret: clientSecret, ...(oauth.scopes?.length ? { scope: oauth.scopes.join(" ") } : {}) }), signal: requestSignal }), signal);
    if (!response.ok) throw new Error(`MCP OAuth token 请求失败 (${response.status})`);
    const value = await response.json() as { access_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown };
    if (typeof value.access_token !== "string" || !value.access_token) throw new Error("MCP OAuth 响应缺少 access_token");
    const credential = { accessToken: value.access_token, ...(typeof value.token_type === "string" ? { tokenType: value.token_type } : {}), ...(typeof value.expires_in === "number" ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}), ...(typeof value.scope === "string" ? { scope: value.scope } : {}) };
    await this.options.credentialStore.set(this.id, credential);
    return { authorization: `${credential.tokenType ?? "Bearer"} ${credential.accessToken}` };
  }

  private async listAll(kind: "tools" | "resources" | "prompts" | "resourceTemplates", signal?: AbortSignal): Promise<any[]> {
    const rows: any[] = []; let cursor: string | undefined;
    const seenCursors = new Set<string>();
    const deadline = Date.now() + (this.options.timeoutMs ?? this.options.server.timeoutMs ?? 15_000);
    for (let page = 0; page < 100; page += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(`MCP ${kind} catalog 总超时`);
      const params = cursor ? { cursor } : undefined;
      const response = kind === "tools" ? await this.withTimeout((requestSignal) => this.client!.listTools(params, { signal: requestSignal }), signal, remainingMs)
        : kind === "resources" ? await this.withTimeout((requestSignal) => this.client!.listResources(params, { signal: requestSignal }), signal, remainingMs)
          : kind === "prompts" ? await this.withTimeout((requestSignal) => this.client!.listPrompts(params, { signal: requestSignal }), signal, remainingMs)
            : await this.withTimeout((requestSignal) => this.client!.listResourceTemplates(params, { signal: requestSignal }), signal, remainingMs);
      const key = kind === "resourceTemplates" ? "resourceTemplates" : kind;
      rows.push(...((response as any)[key] ?? []));
      if (rows.length > 10_000) throw new Error(`MCP ${kind} catalog 超过 10000 项`);
      cursor = (response as any).nextCursor;
      if (!cursor) return rows;
      if (typeof cursor !== "string" || Buffer.byteLength(cursor, "utf8") > 4096) throw new Error(`MCP ${kind} cursor 无效或过长`);
      if (seenCursors.has(cursor)) throw new Error(`MCP ${kind} 返回重复 cursor`);
      seenCursors.add(cursor);
    }
    throw new Error(`MCP ${kind} 分页超过 100 页`);
  }

  private accepts(uri: string): boolean {
    const prefixes = this.options.resourcePrefixes ?? this.options.server.resourcePrefixes ?? [];
    return prefixes.length === 0 || prefixes.some((prefix) => uri.startsWith(prefix));
  }

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutOverride?: number): Promise<T> {
    const timeout = Math.max(1, timeoutOverride ?? this.options.timeoutMs ?? this.options.server.timeoutMs ?? 15_000);
    if (signal?.aborted) throw signal.reason ?? new Error("MCP request cancelled");
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new Error("MCP request cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<T>((_, reject) => { timer = setTimeout(() => { const error = new Error(`MCP request timeout (${timeout}ms)`); controller.abort(error); reject(error); }, timeout); });
      this.activeSignals.push(controller.signal);
      return await Promise.race([operation(controller.signal), timedOut]);
    } finally { this.activeSignals.pop(); if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("MCP reconnect cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new Error("MCP reconnect cancelled")); };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function filteredMcpEnvironment(patch?: Record<string, string>): Record<string, string> {
  const allowed = new Set(["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL", "NODE_ENV"]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key) && value !== undefined) result[key] = value;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH)/i.test(key)) continue;
    result[key] = value;
  }
  return result;
}

export function createMcpProviders(config: Record<string, SkillMcpServerConfig> | undefined, options: { credentialStore?: McpCredentialStore; elicitationBroker?: McpElicitationBroker } = {}): McpSkillProvider[] {
  return Object.entries(config ?? {}).filter(([, server]) => server.enabled !== false).map(([id, server]) => new McpSkillProvider(id, { server, ...(options.credentialStore ? { credentialStore: options.credentialStore } : {}), ...(options.elicitationBroker ? { elicitationBroker: options.elicitationBroker } : {}) }));
}

/** Registers MCP tools through the normal ToolRegistry/ToolRouter boundary. */
export async function mcpToolRegistrations(providers: McpSkillProvider[], options: { strict?: boolean } = {}): Promise<ToolRegistration[]> {
  const batches = await Promise.all(providers.map(async (provider) => {
    try { return await provider.registrations(); }
    catch (error) { if (options.strict) throw error; return []; }
  }));
  return batches.flat();
}
