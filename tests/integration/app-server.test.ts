import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { AppServer } from "../../src/server/app-server.js";
import { makeContext, makeWorkspace } from "../helpers.js";
import { Observability } from "../../src/core/observability.js";
import { PluginLifecycleManager } from "../../src/skills/plugin-manager.js";
import { McpRuntimeManager } from "../../src/skills/mcp-manager.js";
import { LocalSkillProvider, SkillPlatform } from "../../src/skills/platform.js";
import { McpCredentialStore } from "../../src/skills/mcp-credentials.js";
import http from "node:http";

test("AppServer exposes session create, turn, transcript and task RPC", async () => {
  const root = await makeWorkspace();
  const server = new AppServer(() => makeContext(root));
  const port = await server.listen();
  try {
    const call = async (method: string, params: Record<string, unknown> = {}) => (await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as { result?: any; error?: { message: string } };
    assert.equal((await call("initialize")).result.protocolVersion, "1.0");
    const created = await call("session.create");
    assert.ok(created.result.sessionId);
    const id = created.result.sessionId as string;
    const tools = await call("tool.status", { sessionId: id });
    assert.equal(tools.result.tools.some((tool: any) => tool.name === "read_file"), true);
    const turned = await call("turn.start", { sessionId: id, prompt: "inspect" });
    assert.match(turned.result.answer, /FakeModel/);
    const transcript = await call("transcript.read", { sessionId: id, limit: 20 });
    assert.ok(Array.isArray(transcript.result) && transcript.result.length > 0);
    const events = await call("events.read", { after: -1, limit: 100 });
    assert.equal(events.result.events.some((entry: any) => entry.event.type === "turn_completed"), true);
    const streamResponse = await fetch(`http://127.0.0.1:${port}/events?after=${events.result.next - 1}`);
    const reader = streamResponse.body!.getReader(); const firstChunk = await reader.read();
    assert.match(new TextDecoder().decode(firstChunk.value), /agent_event|connected/); await reader.cancel();
    assert.deepEqual((await call("session.close", { sessionId: id })).result, { ok: true });
    const resumed = await call("session.resume", { sessionId: id });
    assert.equal(resumed.result.sessionId, id);
    assert.deepEqual((await call("session.close", { sessionId: id })).result, { ok: true });
    const forked = await call("session.fork", { parentSessionId: id, reason: "test" });
    assert.notEqual(forked.result.sessionId, id);
    assert.deepEqual((await call("session.close", { sessionId: forked.result.sessionId })).result, { ok: true });
  } finally { await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("AppServer bearer authentication protects JSON-RPC and SSE", async () => {
  const root = await makeWorkspace();
  const server = new AppServer(() => makeContext(root), undefined, undefined, { authToken: "test-token" });
  const port = await server.listen();
  try {
    const denied = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
    assert.equal((await allowed.json() as any).result.protocolVersion, "1.0");
  } finally { await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("AppServer replays durable events after a server restart", async () => {
  const root = await makeWorkspace(); const observability = new Observability(1_000, path.join(root, "events.sqlite"));
  const factory = async () => { const ctx = await makeContext(root); ctx.observability = observability; return ctx; };
  const call = async (port: number, method: string, params: Record<string, unknown> = {}) => (await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as { result?: any; error?: { message: string } };
  const first = new AppServer(factory, undefined, observability); const firstPort = await first.listen();
  try {
    const id = (await call(firstPort, "session.create")).result.sessionId as string;
    await call(firstPort, "turn.start", { sessionId: id, prompt: "inspect" });
    await call(firstPort, "session.close", { sessionId: id });
  } finally { await first.close(); }
  const cursor = observability.currentCursor;
  const second = new AppServer(factory, undefined, observability); const secondPort = await second.listen();
  try {
    const replay = await call(secondPort, "events.read", { after: 0, limit: 500 });
    assert.equal(replay.result.events.some((entry: any) => entry.event.type === "turn_completed"), true);
    assert.equal(replay.result.next, cursor);
  } finally { await second.close(); observability.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("AppServer plugin management waits for approval and denial preserves state", async () => {
  const root = await makeWorkspace(); const installRoot = path.join(root, "plugins"); const pluginRoot = path.join(installRoot, "demo", "1.0.0");
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ id: "demo", version: "1.0.0" }));
  await fs.writeFile(path.join(installRoot, "registry.json"), JSON.stringify({ demo: { id: "demo", enabled: true, activeVersion: "1.0.0", versions: ["1.0.0"] } }));
  const lifecycle = new PluginLifecycleManager(installRoot); await lifecycle.load();
  const server = new AppServer(async () => { const ctx = await makeContext(root); ctx.pluginLifecycle = lifecycle; return ctx; }); const port = await server.listen();
  const call = async (method: string, params: Record<string, unknown> = {}) => (await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as { result?: any; error?: { message: string } };
  try {
    const id = (await call("session.create")).result.sessionId as string;
    const disabling = call("plugin.disable", { sessionId: id, pluginId: "demo" });
    let pending: any[] = [];
    for (let attempt = 0; attempt < 100 && pending.length === 0; attempt += 1) { pending = (await call("approval.list", { sessionId: id })).result; if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.equal(pending.length, 1);
    await call("approval.resolve", { sessionId: id, requestId: pending[0].requestId, approved: false });
    assert.match((await disabling).error?.message ?? "", /未获批准/);
    assert.equal(lifecycle.isEnabled("demo"), true);
    await call("session.close", { sessionId: id });
  } finally { await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("AppServer dynamically adds and removes a real MCP server through approval", async () => {
  const root = await makeWorkspace(); const ctx = await makeContext(root);
  const local = new LocalSkillProvider("local", root, { userRoots: [] }); ctx.skillPlatform = new SkillPlatform([local]);
  const manager = new McpRuntimeManager(path.join(root, "state", "mcp-servers.json"), {}); ctx.mcpManager = manager; ctx.mcpProviders = await manager.initialize();
  const server = new AppServer(async () => ctx); const port = await server.listen();
  const call = async (method: string, params: Record<string, unknown> = {}) => (await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as { result?: any; error?: { message: string } };
  try {
    const id = (await call("session.create")).result.sessionId as string;
    const approve = async (operation: Promise<{ result?: any; error?: { message: string } }>) => {
      let pending: any[] = [];
      for (let attempt = 0; attempt < 100 && pending.length === 0; attempt += 1) { pending = (await call("approval.list", { sessionId: id })).result; if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 5)); }
      assert.equal(pending.length, 1); await call("approval.resolve", { sessionId: id, requestId: pending[0].requestId, approved: true }); return operation;
    };
    const fixture = path.resolve("tests", "fixtures", "mcp-skill-server.mjs");
    const added = await approve(call("mcp.add", { sessionId: id, serverId: "fixture", server: { transport: "stdio", command: process.execPath, args: [fixture], timeoutMs: 5_000 } }));
    assert.equal(added.result[0].state, "ready");
    assert.equal((await call("tool.status", { sessionId: id })).result.tools.some((tool: any) => tool.name === "mcp.fixture.echo"), true);
    const removed = await approve(call("mcp.remove", { sessionId: id, serverId: "fixture" })); assert.deepEqual(removed.result, []);
    assert.equal((await call("tool.status", { sessionId: id })).result.tools.some((tool: any) => tool.name === "mcp.fixture.echo"), false);
    await call("session.close", { sessionId: id });
  } finally { await server.close(); await manager.close(); await ctx.skillPlatform.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("AppServer exposes OAuth PKCE begin and complete through the approval protocol", async () => {
  const root = await makeWorkspace(); const tokenServer = http.createServer(async (_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ access_token: "public-oauth-token", expires_in: 3600 })); });
  await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
  const tokenUrl = `http://127.0.0.1:${(tokenServer.address() as { port: number }).port}/token`; const fixture = path.resolve("tests", "fixtures", "mcp-skill-server.mjs");
  const credentials = new McpCredentialStore(path.join(root, "credentials.json"));
  const manager = new McpRuntimeManager(path.join(root, "mcp.json"), { secure: { transport: "stdio", command: process.execPath, args: [fixture], oauth: { grantType: "authorization_code", clientId: "client", authorizationUrl: "https://auth.invalid/authorize", tokenUrl } } }, credentials);
  const providers = await manager.initialize(); const ctx = await makeContext(root); ctx.mcpManager = manager; ctx.mcpProviders = providers;
  const server = new AppServer(async () => ctx); const port = await server.listen();
  const call = async (method: string, params: Record<string, unknown> = {}) => (await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as { result?: any; error?: { message: string } };
  try {
    const id = (await call("session.create")).result.sessionId as string;
    const approve = async (operation: Promise<{ result?: any; error?: { message: string } }>) => {
      let pending: any[] = []; for (let attempt = 0; attempt < 100 && pending.length === 0; attempt += 1) { pending = (await call("approval.list", { sessionId: id })).result; if (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 5)); }
      assert.equal(pending.length, 1); await call("approval.resolve", { sessionId: id, requestId: pending[0].requestId, approved: true }); return operation;
    };
    const begin = await approve(call("mcp.oauth.begin", { sessionId: id, serverId: "secure" })); assert.ok(begin.result.authorizationUrl); assert.equal(begin.result.verifier, undefined); assert.ok(begin.result.state);
    const complete = await approve(call("mcp.oauth.complete", { sessionId: id, transactionId: begin.result.id, code: "code", state: begin.result.state })); assert.equal(complete.result[0].state, "ready");
    assert.equal((await credentials.get("secure"))?.accessToken, "public-oauth-token");
    await call("session.close", { sessionId: id });
  } finally { await server.close(); await manager.close(); await ctx.shell.close(); await tokenServer.close(); await fs.rm(root, { recursive: true, force: true }); }
});
