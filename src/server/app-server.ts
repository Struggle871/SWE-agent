import http from "node:http";
import fs from "node:fs/promises";
import { AgentSession } from "../core/agent-session.js";
import type { AgentContext } from "../types.js";
import type { AgentEvent } from "../core/events.js";
import { ServerApprovalBroker } from "./approval-broker.js";
import type { ApprovalBroker } from "../security/approval-broker.js";
import { MarketplaceIndex } from "../skills/plugin-manager.js";
import { randomUUID } from "node:crypto";
import type { ApprovalRequest } from "../security/approval-broker.js";
import type { Observability } from "../core/observability.js";

interface RpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
type ContextFactory = () => Promise<AgentContext>;
export interface AppServerOptions { authToken?: string }

/** Minimal JSON-RPC control plane. UI clients never import SessionCoordinator. */
export class AppServer {
  private readonly sessions = new Map<string, { session: AgentSession; context: AgentContext }>();
  private readonly approvals = new Map<string, ServerApprovalBroker>();
  private readonly events: Array<{ cursor: number; event: AgentEvent }> = [];
  private nextCursor: number;
  private readonly subscribers = new Set<http.ServerResponse>();
  private server?: http.Server;
  private readonly authToken?: string;
  constructor(private readonly createContext: ContextFactory, private readonly onEvent?: (event: AgentEvent) => void, private readonly eventStore?: Observability, options: AppServerOptions = {}) {
    this.authToken = options.authToken?.trim() || undefined;
    this.nextCursor = (eventStore?.currentCursor ?? -1) + 1;
  }

  async listen(port = 0): Promise<number> {
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(port, "127.0.0.1", () => resolve()); });
    return (this.server.address() as { port: number }).port;
  }
  async close(): Promise<void> { for (const response of this.subscribers) response.end(); this.subscribers.clear(); for (const broker of this.approvals.values()) broker.rejectAll(); await Promise.all([...this.sessions.values()].map(async ({ session, context }) => { await session.close(); await context.shell.close(); })); await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve()); }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (this.authToken && !authorized(request, this.authToken)) { response.writeHead(401, { "www-authenticate": "Bearer" }); response.end(); return; }
    if (request.method === "GET" && request.url?.startsWith("/events")) { this.streamEvents(request, response); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let requestId: string | number | null = null;
    try {
      const rpc = JSON.parse(await readBody(request)) as RpcRequest;
      requestId = rpc.id ?? null;
      if (rpc.jsonrpc !== undefined && rpc.jsonrpc !== "2.0") throw new Error("仅支持 JSON-RPC 2.0");
      if (!rpc.method || typeof rpc.method !== "string") throw new Error("JSON-RPC method 必须是非空字符串");
      if (rpc.params !== undefined && (!rpc.params || typeof rpc.params !== "object" || Array.isArray(rpc.params))) throw new Error("JSON-RPC params 必须是对象");
      const result = await this.dispatch(rpc.method ?? "", rpc.params ?? {});
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }));
    } catch (error) {
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }));
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "initialize") return { protocolVersion: "1.0", capabilities: { sessions: true, events: true, approvals: true, tasks: true, metrics: true, tools: true, skills: true, mcp: true, plugins: true, mcpOAuth: true, mcpElicitation: true } };
    if (method === "session.create" || method === "session.resume" || method === "session.fork") {
      const context = await this.createContext();
      const broker = new ServerApprovalBroker();
      context.approvalBroker = broker;
      const eventHandler = (event: AgentEvent) => this.publish(event);
      let session: AgentSession;
      if (method === "session.resume") session = await AgentSession.resume(context, String(params.sessionId ?? ""), eventHandler);
      else if (method === "session.fork") session = await AgentSession.fork(context, String(params.parentSessionId ?? ""), { atOrdinal: params.atOrdinal === undefined ? undefined : Number(params.atOrdinal), reason: typeof params.reason === "string" ? params.reason : "app server fork" }, eventHandler);
      else session = new AgentSession(context, eventHandler);
      this.sessions.set(session.sessionId, { session, context });
      this.approvals.set(session.sessionId, broker);
      return { sessionId: session.sessionId, transcriptPath: session.transcriptPath };
    }
    if (method === "events.read") {
      const after = Number(params.after ?? -1); const limit = Math.min(Math.max(Number(params.limit ?? 100), 1), 500);
      const rows = this.eventStore?.events(after, limit) ?? this.events.filter((entry) => entry.cursor > after).slice(0, limit);
      const bounds = this.eventStore?.eventBounds();
      return { events: rows, next: rows.at(-1)?.cursor ?? after, droppedBefore: bounds?.oldest ?? this.events[0]?.cursor ?? this.nextCursor };
    }
    const sessionId = String(params.sessionId ?? "");
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`session 不存在: ${sessionId}`);
    const session = entry.session;
    if (method === "turn.start") return session.run(String(params.prompt ?? ""));
    if (method === "turn.interrupt") { session.interrupt(String(params.reason ?? "app server interrupt")); return { ok: true }; }
    if (method === "turn.steer") { const text = String(params.text ?? ""); if (!text.trim()) throw new Error("turn.steer text 不能为空"); session.steer(text); return { ok: true }; }
    if (method === "approval.list") return this.approvals.get(sessionId)?.list() ?? [];
    if (method === "approval.resolve") { this.approvals.get(sessionId)?.resolve(String(params.requestId ?? ""), params.approved === true, params.scope === "session" ? "session" : "once"); return { ok: true }; }
    if (method === "metrics.list") return entry.context.observability?.list() ?? [];
    if (method === "session.get") return { sessionId: session.sessionId, state: session.sessionState, active: session.hasActiveTurn, transcriptPath: session.transcriptPath, tasks: session.tasks };
    if (method === "skill.status") return entry.context.skillPlatform ? { skills: entry.context.skillPlatform.skills(), diagnostics: entry.context.skillPlatform.diagnostics() } : { skills: [], diagnostics: [] };
    if (method === "tool.status") return { generation: entry.context.registry.currentGeneration, tools: entry.context.registry.status() };
    if (method === "mcp.status") return entry.context.pluginActivation?.allMcpProviders().map((provider) => provider.status) ?? entry.context.mcpProviders?.map((provider) => provider.status) ?? [];
    if (method === "mcp.refresh") { if (entry.context.mcpManager) return entry.context.mcpManager.refresh(entry.context); for (const provider of entry.context.mcpProviders ?? []) await provider.refresh(); return entry.context.mcpProviders?.map((provider) => provider.status) ?? []; }
    if (method === "mcp.add") {
      if (!entry.context.mcpManager) throw new Error("MCP runtime manager 未启用");
      const serverId = String(params.serverId ?? ""); const server = params.server;
      if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error("mcp.add server 必须是对象");
      await requireManagementApproval(entry.context, { operation: method, target: serverId, risk: "network" });
      return entry.context.mcpManager.add(entry.context, serverId, server as unknown as import("../types.js").SkillMcpServerConfig);
    }
    if (method === "mcp.remove") {
      if (!entry.context.mcpManager) throw new Error("MCP runtime manager 未启用");
      const serverId = String(params.serverId ?? "");
      await requireManagementApproval(entry.context, { operation: method, target: serverId, risk: "destructive" });
      return entry.context.mcpManager.remove(entry.context, serverId);
    }
    if (method === "mcp.oauth.transactions") return entry.context.mcpManager?.oauthTransactions() ?? [];
    if (method === "mcp.oauth.begin") {
      if (!entry.context.mcpManager) throw new Error("MCP runtime manager 未启用");
      await requireManagementApproval(entry.context, { operation: method, target: String(params.serverId ?? ""), risk: "network" });
      return entry.context.mcpManager.oauthBegin(String(params.serverId ?? ""));
    }
    if (method === "mcp.oauth.complete") {
      if (!entry.context.mcpManager) throw new Error("MCP runtime manager 未启用");
      const code = String(params.code ?? ""); const state = String(params.state ?? ""); const transactionId = String(params.transactionId ?? "");
      if (!code || !state || !transactionId) throw new Error("mcp.oauth.complete 需要 transactionId/code/state");
      await requireManagementApproval(entry.context, { operation: method, target: transactionId, risk: "network" });
      return entry.context.mcpManager.oauthComplete(entry.context, transactionId, code, state);
    }
    if (method === "mcp.elicitation.list") return entry.context.mcpManager?.elicitationBroker?.list() ?? [];
    if (method === "mcp.elicitation.resolve") {
      const broker = entry.context.mcpManager?.elicitationBroker; if (!broker) throw new Error("MCP elicitation broker 未启用");
      const id = String(params.id ?? ""); const action = params.action;
      if (action !== "accept" && action !== "decline" && action !== "cancel") throw new Error("elicitation action 无效");
      const content = params.content && typeof params.content === "object" && !Array.isArray(params.content) ? params.content as Record<string, string | number | boolean | string[]> : undefined;
      broker.resolve(id, { action, ...(content ? { content } : {}) }); return { ok: true };
    }
    if (method === "mcp.catalog") return (entry.context.mcpProviders ?? []).map((provider) => ({ id: provider.id, ...provider.catalog() }));
    if (method === "mcp.prompt.get") { const provider = requireMcp(entry.context, String(params.serverId ?? "")); return provider.getPrompt(String(params.name ?? ""), stringRecord(params.arguments)); }
    if (method === "mcp.resource.read") { const provider = requireMcp(entry.context, String(params.serverId ?? "")); return provider.read(String(params.uri ?? "")); }
    if (method === "mcp.resource.subscribe" || method === "mcp.resource.unsubscribe") { const provider = requireMcp(entry.context, String(params.serverId ?? "")); if (method === "mcp.resource.subscribe") await provider.subscribe(String(params.uri ?? "")); else await provider.unsubscribe(String(params.uri ?? "")); return { ok: true }; }
    if (method === "plugin.status") return entry.context.pluginActivation?.status() ?? entry.context.pluginLifecycle?.list() ?? [];
    if (method === "plugin.refresh") return entry.context.pluginActivation?.refresh(entry.context) ?? { generation: entry.context.registry.currentGeneration, plugins: [], mcp: [] };
    if (method === "plugin.enable" || method === "plugin.disable") {
      const lifecycle = entry.context.pluginLifecycle; if (!lifecycle) throw new Error("Plugin lifecycle 未启用");
      await requireManagementApproval(entry.context, { operation: method, target: String(params.pluginId ?? ""), risk: "write" });
      const checkpoint = await lifecycle.checkpoint();
      try {
        if (method === "plugin.enable") await lifecycle.enable(String(params.pluginId ?? "")); else await lifecycle.disable(String(params.pluginId ?? ""));
        const output = await entry.context.pluginActivation?.refresh(entry.context) ?? lifecycle.list();
        await lifecycle.discard(checkpoint);
        return output;
      } catch (error) {
        await lifecycle.restore(checkpoint);
        await entry.context.pluginActivation?.refresh(entry.context).catch(() => undefined);
        throw error;
      }
    }
    if (method === "plugin.install" || method === "plugin.upgrade" || method === "plugin.uninstall") {
      const lifecycle = entry.context.pluginLifecycle; if (!lifecycle) throw new Error("Plugin lifecycle 未启用");
      const pluginId = String(params.pluginId ?? "");
      await requireManagementApproval(entry.context, { operation: method, target: pluginId || String(params.url ?? ""), risk: method === "plugin.uninstall" ? "destructive" : "network" });
      const callId = `app-plugin-${Date.now()}`;
      const checkpoint = await lifecycle.checkpoint();
      await entry.context.auditTrail.record({ timestamp: Date.now(), callId, toolName: method, phase: "preflight", decision: "allow", input: { pluginId, ...(typeof params.url === "string" ? { url: params.url } : {}) } });
      try {
        const index = new MarketplaceIndex(); const indexes = entry.context.config.skills?.marketplaceIndexes ?? [];
        const output = method === "plugin.install"
          ? await lifecycle.install(String(params.url ?? ""), undefined, index, indexes)
          : method === "plugin.upgrade"
            ? await lifecycle.upgrade(pluginId, index, indexes, typeof params.range === "string" ? params.range : "*")
            : await lifecycle.uninstall(pluginId, typeof params.version === "string" ? params.version : undefined).then(() => lifecycle.list().find((item) => item.id === pluginId) ?? null);
        const activated = await entry.context.pluginActivation?.refresh(entry.context) ?? output;
        await lifecycle.discard(checkpoint);
        await entry.context.auditTrail.record({ timestamp: Date.now(), callId, toolName: method, phase: "execution", success: true, input: { pluginId } });
        return activated;
      } catch (error) {
        await lifecycle.restore(checkpoint).catch(() => undefined);
        await entry.context.pluginActivation?.refresh(entry.context).catch(() => undefined);
        await entry.context.auditTrail.record({ timestamp: Date.now(), callId, toolName: method, phase: "execution", success: false, error: error instanceof Error ? error.message : String(error), input: { pluginId } });
        throw error;
      }
    }
    if (method === "session.close") { await session.close(); await entry.context.shell.close(); this.approvals.get(sessionId)?.rejectAll("session closed"); this.approvals.delete(sessionId); this.sessions.delete(sessionId); return { ok: true }; }
    if (method === "transcript.read") return (await fs.readFile(session.transcriptPath, "utf8")).split(/\r?\n/).filter(Boolean).slice(Number(params.offset ?? 0), Number(params.offset ?? 0) + Math.min(Number(params.limit ?? 100), 500));
    if (method === "task.list") return session.tasks;
    throw new Error(`未知 JSON-RPC 方法: ${method}`);
  }

  private publish(event: AgentEvent): void {
    const cursor = Math.max(this.nextCursor, this.eventStore?.currentCursor ?? -1);
    this.nextCursor = cursor + 1;
    this.events.push({ cursor, event });
    if (this.events.length > 10_000) this.events.splice(0, this.events.length - 10_000);
    const payload = `id: ${cursor}\nevent: agent_event\ndata: ${JSON.stringify({ cursor, event })}\n\n`;
    for (const response of this.subscribers) response.write(payload);
    this.onEvent?.(event);
  }

  private streamEvents(request: http.IncomingMessage, response: http.ServerResponse): void {
    const url = new URL(request.url ?? "/events", "http://127.0.0.1");
    const requested = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? -1);
    const durable = this.eventStore?.events(requested, 500) ?? [];
    const backlog = durable.length > 0 ? durable : this.events.filter((item) => item.cursor > requested);
    const oldest = this.eventStore?.eventBounds().oldest ?? this.events[0]?.cursor ?? this.nextCursor;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    if (requested >= 0 && requested < oldest - 1) response.write(`event: gap\ndata: ${JSON.stringify({ requested, availableFrom: oldest })}\n\n`);
    for (const entry of backlog) response.write(`id: ${entry.cursor}\nevent: agent_event\ndata: ${JSON.stringify(entry)}\n\n`);
    response.write(": connected\n\n");
    this.subscribers.add(response);
    const cleanup = () => this.subscribers.delete(response);
    request.once("close", cleanup); response.once("close", cleanup);
  }
}

function authorized(request: http.IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") && header.slice(7) === expected;
}

function requireMcp(ctx: AgentContext, id: string) { const provider = ctx.mcpManager?.get(id) ?? ctx.mcpProviders?.find((item) => item.id === id); if (!provider) throw new Error(`MCP server 不存在: ${id}`); return provider; }
function stringRecord(value: unknown): Record<string, string> { if (!value || typeof value !== "object" || Array.isArray(value)) return {}; return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")); }
async function requireManagementApproval(ctx: AgentContext, input: { operation: string; target: string; risk: "write" | "network" | "destructive" }): Promise<void> {
  const request: ApprovalRequest = { requestId: randomUUID(), permissionFingerprint: ctx.permissionPolicy.fingerprint(), preview: { callId: `management-${Date.now()}`, toolName: input.operation, summary: `${input.operation}: ${input.target}`, risk: input.risk, cwd: ctx.workspaceRoot, affectedPaths: input.target ? [input.target] : [], reasons: ["App Server 管理操作需要显式批准"] } };
  await ctx.auditTrail.record({ timestamp: Date.now(), callId: request.preview.callId, toolName: input.operation, phase: "preflight", decision: "ask", preview: request.preview });
  const result = await ctx.approvalBroker.request(request, new AbortController().signal);
  await ctx.auditTrail.record({ timestamp: Date.now(), callId: request.preview.callId, toolName: input.operation, phase: "approval", approval: result, preview: request.preview });
  if (!result.approved) throw new Error(`${input.operation} 未获批准`);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body) > 1_000_000) throw new Error("JSON-RPC request 超过 1MiB"); }
  return body;
}
