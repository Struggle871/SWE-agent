import fs from "node:fs/promises";
import path from "node:path";
import type { AgentContext, SkillMcpServerConfig } from "../types.js";
import { createMcpProviders, mcpToolRegistrations, type McpSkillProvider } from "./mcp-provider.js";
import type { McpCredentialStore } from "./mcp-credentials.js";
import type { McpElicitationBroker } from "./mcp-elicitation.js";
import type { McpOAuthTransaction, McpCredential } from "./mcp-credentials.js";
import type { PluginActivationManager } from "./plugin-activation.js";

interface McpOverlayFile { schemaVersion: 1; servers: Record<string, SkillMcpServerConfig | null> }

/** Owns dynamically managed MCP connections and atomically projects them into tools and Skills. */
export class McpRuntimeManager {
  private overlays: Record<string, SkillMcpServerConfig | null> = {};
  private providers: McpSkillProvider[] = [];
  private pluginActivation?: PluginActivationManager;
  private readonly retirements: Promise<void>[] = [];

  constructor(private readonly filePath: string, private readonly configured: Readonly<Record<string, SkillMcpServerConfig>>, private readonly credentials?: McpCredentialStore, private readonly elicitation?: McpElicitationBroker) {}

  async initialize(): Promise<readonly McpSkillProvider[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<McpOverlayFile>;
      if (parsed.schemaVersion !== 1 || !parsed.servers || typeof parsed.servers !== "object" || Array.isArray(parsed.servers)) throw new Error("MCP overlay schema 无效");
      for (const [id, value] of Object.entries(parsed.servers)) { validateId(id); if (value !== null) validateServer(value); this.overlays[id] = value; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.providers = createMcpProviders(this.effective(), { ...(this.credentials ? { credentialStore: this.credentials } : {}), ...(this.elicitation ? { elicitationBroker: this.elicitation } : {}) });
    return [...this.providers];
  }

  attachPluginActivation(activation: PluginActivationManager): void { this.pluginActivation = activation; }
  get elicitationBroker(): McpElicitationBroker | undefined { return this.elicitation; }
  status(): readonly McpSkillProvider["status"][] { return this.providers.map((provider) => provider.status); }
  get(id: string): McpSkillProvider | undefined { return this.providers.find((provider) => provider.id === id); }
  getConfig(id: string): SkillMcpServerConfig | undefined { const value = this.effective()[id]; return value ? structuredClone(value) : undefined; }
  oauthTransactions(): Promise<readonly Omit<McpOAuthTransaction, "verifier">[]> { if (!this.credentials) return Promise.resolve([]); return this.credentials.transactions(); }
  async oauthBegin(id: string): Promise<Omit<McpOAuthTransaction, "verifier">> {
    const config = this.getConfig(id)?.oauth; if (!config || !this.credentials) throw new Error(`MCP ${id} 未配置 OAuth credential store`);
    return this.credentials.beginAuthorization(id, config).then(({ verifier: _verifier, ...transaction }) => transaction);
  }
  async oauthComplete(ctx: AgentContext, transactionId: string, code: string, state: string): Promise<readonly McpSkillProvider["status"][]> {
    const transactions = await this.oauthTransactions(); const transaction = transactions.find((item) => item.id === transactionId);
    if (!transaction) throw new Error(`MCP OAuth transaction 不存在: ${transactionId}`);
    const config = this.getConfig(transaction.serverId)?.oauth; if (!config || !this.credentials) throw new Error(`MCP ${transaction.serverId} OAuth 配置不存在`);
    await this.credentials.completeAuthorization(transactionId, code, state, config);
    return this.refresh(ctx);
  }

  async add(ctx: AgentContext, id: string, server: SkillMcpServerConfig): Promise<readonly McpSkillProvider["status"][]> {
    validateId(id); validateServer(server);
    return this.mutate(ctx, () => { this.overlays[id] = structuredClone(server); });
  }

  async remove(ctx: AgentContext, id: string): Promise<readonly McpSkillProvider["status"][]> {
    validateId(id);
    if (!(id in this.effective())) throw new Error(`MCP server 不存在: ${id}`);
    return this.mutate(ctx, () => { this.overlays[id] = null; });
  }

  async refresh(ctx: AgentContext): Promise<readonly McpSkillProvider["status"][]> {
    const next = createMcpProviders(this.effective(), { ...(this.credentials ? { credentialStore: this.credentials } : {}), ...(this.elicitation ? { elicitationBroker: this.elicitation } : {}) });
    const registrations = (await Promise.all(next.map(async (provider) => {
      try { return await mcpToolRegistrations([provider], { strict: true }); }
      catch { return []; }
    }))).flat().map((registration) => ({ ...registration, source: `mcp-managed:${registration.source}` }));
    try {
      const replacement = ctx.registry.replaceSourcesWithDrain(["mcp-managed:"], registrations);
      const previous = this.providers; const managedIds = new Set([...previous, ...next].map((provider) => provider.id));
      this.providers = next;
      this.pluginActivation?.replaceBaseMcpProviders(next);
      if (this.pluginActivation) {
        ctx.mcpProviders = this.pluginActivation.allMcpProviders();
        ctx.skillPlatform?.replaceProviders(this.pluginActivation.allProviders());
      } else {
        ctx.mcpProviders = [...(ctx.mcpProviders ?? []).filter((provider) => !managedIds.has(provider.id)), ...next];
        const retained = ctx.skillPlatform?.providerList().filter((provider) => !(provider.kind === "mcp" && managedIds.has(provider.id))) ?? [];
        ctx.skillPlatform?.replaceProviders([...retained, ...next]);
      }
      const retirement = replacement.drained.then(() => Promise.all(previous.map((provider) => provider.close().catch(() => undefined)))).then(() => undefined);
      this.retirements.push(retirement); void retirement.finally(() => { const index = this.retirements.indexOf(retirement); if (index >= 0) this.retirements.splice(index, 1); });
      return this.status();
    } catch (error) { await Promise.all(next.map((provider) => provider.close().catch(() => undefined))); throw error; }
  }

  async close(): Promise<void> { await Promise.all([...this.retirements, ...this.providers.map((provider) => provider.close().catch(() => undefined))]); this.providers = []; }

  private effective(): Record<string, SkillMcpServerConfig> {
    const result: Record<string, SkillMcpServerConfig> = structuredClone(this.configured);
    for (const [id, value] of Object.entries(this.overlays)) { if (value === null) delete result[id]; else result[id] = structuredClone(value); }
    return result;
  }

  private async mutate(ctx: AgentContext, change: () => void): Promise<readonly McpSkillProvider["status"][]> {
    const before = structuredClone(this.overlays); change(); await this.persist();
    try { return await this.refresh(ctx); }
    catch (error) { this.overlays = before; await this.persist(); await this.refresh(ctx).catch(() => undefined); throw error; }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true }); const temp = `${this.filePath}.${process.pid}.tmp`;
    const payload: McpOverlayFile = { schemaVersion: 1, servers: this.overlays };
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 }); await fs.rename(temp, this.filePath);
  }
}

function validateId(id: string): void { if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`MCP server id 非法: ${id}`); }
function validateServer(server: SkillMcpServerConfig): void {
  if (!server || (server.transport !== "stdio" && server.transport !== "http")) throw new Error("MCP transport 必须是 stdio 或 http");
  if (server.transport === "stdio" && (!server.command || server.url)) throw new Error("stdio MCP 需要 command 且不能声明 url");
  if (server.transport === "http") { if (!server.url) throw new Error("http MCP 需要 url"); try { const url = new URL(server.url); if (!/^https?:$/.test(url.protocol)) throw new Error(); } catch { throw new Error("MCP url 必须是 http/https URL"); } }
  if (server.timeoutMs !== undefined && (!Number.isInteger(server.timeoutMs) || server.timeoutMs <= 0 || server.timeoutMs > 300_000)) throw new Error("MCP timeoutMs 必须在 1..300000");
}
