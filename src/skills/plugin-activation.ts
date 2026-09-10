import type { AgentContext, HookConfig } from "../types.js";
import type { ToolRegistration } from "../tools/types.js";
import { createMcpProviders, mcpToolRegistrations, type McpSkillProvider } from "./mcp-provider.js";
import { PluginLifecycleManager } from "./plugin-manager.js";
import { SkillScriptAdapter, runSkillScript, type SkillProvider } from "./platform.js";
import { McpCredentialStore } from "./mcp-credentials.js";

export interface PluginActivationStatus { generation: number; plugins: Array<{ id: string; version: string }>; mcp: Array<McpSkillProvider["status"]> }

/** Validates a complete plugin generation before swapping live tools/providers. */
export class PluginActivationManager {
  private pluginProviders: McpSkillProvider[] = [];
  private readonly retiring: Promise<void>[] = [];
  private generation = 0;
  constructor(
    private readonly lifecycle: PluginLifecycleManager,
    private baseProviders: readonly SkillProvider[],
    private baseMcpProviders: readonly McpSkillProvider[],
    private readonly baseHooks: readonly HookConfig[],
    private readonly credentialStore?: McpCredentialStore,
  ) {}

  async refresh(ctx: AgentContext, signal?: AbortSignal): Promise<PluginActivationStatus> {
    const contributions = await this.lifecycle.contributions();
    const configs = Object.assign({}, ...contributions.map((item) => item.mcpServers));
    const nextProviders = createMcpProviders(configs, this.credentialStore ? { credentialStore: this.credentialStore } : {});
    const scriptAdapter = new SkillScriptAdapter(runSkillScript);
    const registrations: ToolRegistration[] = contributions.flatMap((item) => item.scripts.map((definition) => ({ ...scriptAdapter.registration(definition), source: `plugin-tool:${item.pluginId}` })));
    try {
      const mcpRegistrations = await mcpToolRegistrations(nextProviders, { strict: true });
      registrations.push(...mcpRegistrations.map((registration) => ({ ...registration, source: `plugin-mcp:${registration.source}` })));
      const replacement = ctx.registry.replaceSourcesWithDrain(["plugin-tool:", "plugin-mcp:"], registrations);
      const hooks = [...this.baseHooks, ...contributions.flatMap((item) => item.hooks)];
      ctx.config.hooks = hooks;
      ctx.hooks?.replace(hooks);
      const localProvider = this.baseProviders.find((provider) => typeof (provider as { setPluginRoots?: unknown }).setPluginRoots === "function") as { setPluginRoots?: (roots: readonly string[]) => void } | undefined;
      localProvider?.setPluginRoots?.(contributions.map((item) => item.root));
      ctx.skillPlatform?.replaceProviders([...this.baseProviders, ...nextProviders]);
      const previous = this.pluginProviders;
      this.pluginProviders = nextProviders;
      ctx.mcpProviders = [...this.baseMcpProviders, ...nextProviders];
      this.generation = replacement.generation;
      const retirement = replacement.drained.then(() => Promise.all(previous.map((provider) => provider.close().catch(() => undefined)))).then(() => undefined);
      this.retiring.push(retirement);
      void retirement.finally(() => { const index = this.retiring.indexOf(retirement); if (index >= 0) this.retiring.splice(index, 1); });
      return this.status(contributions.map((item) => ({ id: item.pluginId, version: item.version })));
    } catch (error) {
      await Promise.all(nextProviders.map((provider) => provider.close().catch(() => undefined)));
      throw error;
    }
  }

  status(plugins = this.lifecycle.list().filter((item) => item.enabled && item.activeVersion).map((item) => ({ id: item.id, version: item.activeVersion! }))): PluginActivationStatus {
    return { generation: this.generation, plugins, mcp: this.pluginProviders.map((provider) => provider.status) };
  }
  replaceBaseMcpProviders(providers: readonly McpSkillProvider[]): void {
    this.baseProviders = [...this.baseProviders.filter((provider) => provider.kind !== "mcp"), ...providers];
    this.baseMcpProviders = [...providers];
  }
  allProviders(): readonly SkillProvider[] { return [...this.baseProviders, ...this.pluginProviders]; }
  allMcpProviders(): readonly McpSkillProvider[] { return [...this.baseMcpProviders, ...this.pluginProviders]; }
  async close(): Promise<void> { await Promise.all([...this.retiring, ...this.pluginProviders.map((provider) => provider.close().catch(() => undefined))]); this.pluginProviders = []; }
}
