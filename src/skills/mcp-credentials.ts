import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SkillMcpServerConfig } from "../types.js";

export interface McpCredential { accessToken: string; expiresAt?: number; tokenType?: string; scope?: string; refreshToken?: string }
export interface McpOAuthTransaction { id: string; serverId: string; state: string; verifier: string; authorizationUrl: string; redirectUri: string; expiresAt: number }

/** File-backed credential lifecycle. Secrets are never returned by status or audit payloads. */
export class McpCredentialStore {
  private cache = new Map<string, McpCredential>();
  private pending = new Map<string, McpOAuthTransaction>();
  private loaded = false;
  constructor(private readonly filePath: string) {}
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Record<string, McpCredential>;
      for (const [key, value] of Object.entries(parsed)) if (/^[A-Za-z0-9._-]+$/.test(key) && value && typeof value.accessToken === "string") this.cache.set(key, { ...value });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      const parsed = JSON.parse(await fs.readFile(`${this.filePath}.oauth`, "utf8")) as Record<string, McpOAuthTransaction>;
      for (const [id, value] of Object.entries(parsed)) if (value && typeof value.serverId === "string" && typeof value.verifier === "string" && value.expiresAt > Date.now()) this.pending.set(id, { ...value });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async get(serverId: string): Promise<McpCredential | undefined> { await this.load(); const value = this.cache.get(serverId); return value ? { ...value } : undefined; }
  async set(serverId: string, credential: McpCredential): Promise<void> { if (!credential.accessToken.trim()) throw new Error("MCP access token 不能为空"); await this.load(); this.cache.set(serverId, { ...credential }); await this.persist(); }
  async remove(serverId: string): Promise<void> { await this.load(); this.cache.delete(serverId); await this.persist(); }
  async clear(): Promise<void> { await this.load(); this.cache.clear(); await this.persist(); }
  async beginAuthorization(serverId: string, oauth: NonNullable<SkillMcpServerConfig["oauth"]>): Promise<McpOAuthTransaction> {
    await this.load();
    if (oauth.grantType !== "authorization_code" || !oauth.authorizationUrl || !oauth.tokenUrl) throw new Error(`MCP ${serverId} 未配置完整 authorization-code OAuth`);
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(24));
    const redirectUri = oauth.redirectUri ?? "http://127.0.0.1:8765/oauth/callback";
    const url = new URL(oauth.authorizationUrl);
    url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", oauth.clientId); url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state); url.searchParams.set("code_challenge", challenge); url.searchParams.set("code_challenge_method", "S256");
    if (oauth.scopes?.length) url.searchParams.set("scope", oauth.scopes.join(" "));
    const transaction: McpOAuthTransaction = { id: randomUUID(), serverId, state, verifier, authorizationUrl: url.toString(), redirectUri, expiresAt: Date.now() + 10 * 60_000 };
    this.pending.set(transaction.id, transaction); await this.persistPending();
    return { ...transaction, verifier: "<redacted>" };
  }
  async completeAuthorization(transactionId: string, code: string, state: string, oauth: NonNullable<SkillMcpServerConfig["oauth"]>, signal?: AbortSignal): Promise<McpCredential> {
    await this.load();
    const transaction = this.pending.get(transactionId);
    if (!transaction || transaction.expiresAt <= Date.now()) throw new Error("MCP OAuth transaction 不存在或已过期");
    if (transaction.state !== state) throw new Error("MCP OAuth state 校验失败");
    if (!code.trim() || !oauth.tokenUrl) throw new Error("MCP OAuth code/token_url 无效");
    const response = await fetchWithSignal(oauth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: oauth.clientId, redirect_uri: transaction.redirectUri, code_verifier: transaction.verifier, ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}) }) }, signal);
    if (!response.ok) throw new Error(`MCP OAuth code exchange 失败 (${response.status})`);
    const value = await response.json() as { access_token?: unknown; refresh_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown };
    if (typeof value.access_token !== "string" || !value.access_token) throw new Error("MCP OAuth 响应缺少 access_token");
    const credential: McpCredential = { accessToken: value.access_token, ...(typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}), ...(typeof value.token_type === "string" ? { tokenType: value.token_type } : {}), ...(typeof value.expires_in === "number" ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}), ...(typeof value.scope === "string" ? { scope: value.scope } : {}) };
    this.cache.set(transaction.serverId, credential); this.pending.delete(transactionId); await this.persist(); await this.persistPending();
    return { ...credential, accessToken: "<redacted>" };
  }
  async refresh(serverId: string, oauth: NonNullable<SkillMcpServerConfig["oauth"]>, signal?: AbortSignal): Promise<McpCredential | undefined> {
    await this.load();
    const current = this.cache.get(serverId);
    if (!current?.refreshToken || !oauth.tokenUrl) return undefined;
    const response = await fetchWithSignal(oauth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: oauth.clientId, ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}), ...(oauth.scopes?.length ? { scope: oauth.scopes.join(" ") } : {}) }) }, signal);
    if (!response.ok) throw new Error(`MCP OAuth refresh 失败 (${response.status})`);
    const value = await response.json() as { access_token?: unknown; refresh_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown };
    if (typeof value.access_token !== "string" || !value.access_token) throw new Error("MCP OAuth refresh 响应缺少 access_token");
    const credential: McpCredential = { accessToken: value.access_token, refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : current.refreshToken, ...(typeof value.token_type === "string" ? { tokenType: value.token_type } : current.tokenType ? { tokenType: current.tokenType } : {}), ...(typeof value.expires_in === "number" ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}), ...(typeof value.scope === "string" ? { scope: value.scope } : current.scope ? { scope: current.scope } : {}) };
    this.cache.set(serverId, credential); await this.persist(); return { ...credential };
  }
  async transactions(): Promise<readonly Omit<McpOAuthTransaction, "verifier">[]> { await this.load(); return [...this.pending.values()].filter((item) => item.expiresAt > Date.now()).map(({ verifier: _verifier, ...item }) => ({ ...item })); }
  private async persist(): Promise<void> { await fs.mkdir(path.dirname(this.filePath), { recursive: true }); const temp = `${this.filePath}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(Object.fromEntries(this.cache), null, 2), { encoding: "utf8", mode: 0o600 }); await fs.rename(temp, this.filePath); }
  private async persistPending(): Promise<void> { await fs.mkdir(path.dirname(this.filePath), { recursive: true }); const file = `${this.filePath}.oauth`; const temp = `${file}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(Object.fromEntries(this.pending), null, 2), { encoding: "utf8", mode: 0o600 }); await fs.rename(temp, file); }
}

function base64Url(value: Buffer): string { return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
async function fetchWithSignal(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> { if (signal?.aborted) throw signal.reason ?? new Error("MCP OAuth cancelled"); return fetch(url, { ...init, signal }); }
