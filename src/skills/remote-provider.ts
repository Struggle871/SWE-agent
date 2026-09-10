import type { SkillRemoteProviderConfig, ToolResult } from "../types.js";
import type { RemoteSkillDescription, RemoteSkillTransport, SkillProviderRequest } from "./platform.js";
import { RemoteSkillProvider } from "./platform.js";

/** HTTP protocol used by executor/orchestrator providers. The service owns
 * execution; this adapter owns timeout, cancellation, validation and errors. */
export class HttpSkillTransport implements RemoteSkillTransport {
  constructor(private readonly config: SkillRemoteProviderConfig, private readonly fetcher: typeof fetch = fetch) {}
  async list(request: { provider: string }, signal?: AbortSignal): Promise<readonly RemoteSkillDescription[]> {
    const value = await this.request("skills", { method: "GET" }, signal);
    const rows = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { skills?: unknown }).skills) ? (value as { skills: unknown[] }).skills : [];
    return rows.map(parseDescription);
  }
  async read(request: SkillProviderRequest): Promise<string> {
    const value = await this.request("read", { method: "POST", body: JSON.stringify({ locator: request.locator }) }, request.signal);
    if (!value || typeof value !== "object" || typeof (value as { body?: unknown }).body !== "string") throw new Error("remote provider read 响应缺少 body");
    return (value as { body: string }).body;
  }
  async execute(request: SkillProviderRequest): Promise<ToolResult> {
    const value = await this.request("execute", { method: "POST", body: JSON.stringify({ locator: request.locator, input: request.input ?? {} }) }, request.signal);
    if (!value || typeof value !== "object") throw new Error("remote provider execute 响应无效");
    const row = value as { output?: unknown; isError?: unknown; metadata?: unknown };
    if (typeof row.output !== "string") throw new Error("remote provider execute 响应缺少 output");
    return { toolName: `skill.${this.config.kind}`, output: row.output, isError: row.isError === true, ...(row.metadata && typeof row.metadata === "object" ? { metadata: row.metadata as Record<string, unknown> } : {}) };
  }
  private async request(endpoint: string, init: RequestInit, parent?: AbortSignal): Promise<unknown> {
    const controller = new AbortController(); const relay = () => controller.abort(parent?.reason);
    if (parent?.aborted) relay(); else parent?.addEventListener("abort", relay, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("remote Skill provider timeout")), this.config.timeoutMs ?? 15_000);
    try {
      const response = await this.fetcher(`${this.config.baseUrl.replace(/\/+$/, "")}/${endpoint}`, { ...init, signal: controller.signal, headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...init.headers } });
      if (!response.ok) throw new Error(`remote Skill provider 请求失败 (${response.status})`);
      return response.json();
    } finally { clearTimeout(timer); parent?.removeEventListener("abort", relay); }
  }
}

export function createRemoteSkillProviders(config: Record<string, SkillRemoteProviderConfig> | undefined): RemoteSkillProvider[] {
  return Object.entries(config ?? {}).filter(([, value]) => value.enabled !== false).map(([id, value]) => new RemoteSkillProvider(id, value.kind, new HttpSkillTransport(value)));
}

function parseDescription(value: unknown): RemoteSkillDescription {
  if (!value || typeof value !== "object") throw new Error("remote Skill description 无效");
  const row = value as Record<string, unknown>;
  if (typeof row.locator !== "string" || typeof row.name !== "string" || typeof row.description !== "string") throw new Error("remote Skill description 缺少 locator/name/description");
  return { locator: row.locator, name: row.name, description: row.description, ...(typeof row.bodyHash === "string" ? { bodyHash: row.bodyHash } : {}), ...(typeof row.enabled === "boolean" ? { enabled: row.enabled } : {}), ...(typeof row.allowImplicitInvocation === "boolean" ? { allowImplicitInvocation: row.allowImplicitInvocation } : {}) };
}
