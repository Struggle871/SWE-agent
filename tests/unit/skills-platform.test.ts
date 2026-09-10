import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { makeWorkspace } from "../helpers.js";
import {
  MarketplaceClient,
  RemoteSkillProvider,
  SkillCache,
  SkillPluginManager,
  SkillSelector,
  HeuristicSkillTokenizer,
  ProviderUsageSkillTokenizer,
  SkillScriptAdapter,
  runSkillScript,
  skillScriptDefinitions,
  LocalSkillProvider,
} from "../../src/skills/platform.js";
import type { SkillMetadata, SkillSnapshot } from "../../src/config/skills.js";
import { EmbeddingSkillSelector, PersistentEmbeddingCache } from "../../src/skills/semantic-selector.js";
import { TiktokenSkillTokenizer } from "../../src/skills/tokenizer.js";
import { McpElicitationBroker } from "../../src/skills/mcp-elicitation.js";
import { McpCredentialStore } from "../../src/skills/mcp-credentials.js";
import { McpSkillProvider } from "../../src/skills/mcp-provider.js";
import { MarketplaceIndex, PluginLifecycleManager } from "../../src/skills/plugin-manager.js";
import { mcpToolRegistrations } from "../../src/skills/mcp-provider.js";
import { loadSkillSnapshot } from "../../src/config/skills.js";
import { makeContext, cleanupContext } from "../helpers.js";
import { ToolRouter } from "../../src/core/tool-router.js";
import { qualifiedName } from "../../src/tools/registry.js";

function metadata(id: string, name: string, description: string): SkillMetadata {
  return { id, name, description, path: id, canonicalPath: id, rootPath: id, scope: "user", enabled: true, allowImplicitInvocation: true, body: "body", bodyHash: id, diagnostics: [] };
}

function snapshot(skills: readonly SkillMetadata[]): SkillSnapshot {
  return { skills, roots: [], fingerprint: "f", catalogFingerprint: "c", diagnostics: [] };
}

test("selector is deterministic and only returns implicit skills", () => {
  const skills = [metadata("1", "typescript", "write TypeScript code"), { ...metadata("2", "secret", "private"), allowImplicitInvocation: false }];
  const selector = new SkillSelector(0.5, 2);
  const first = selector.select("please write TypeScript", skills);
  const second = selector.select("please write TypeScript", skills);
  assert.deepEqual(first.selected.map((item) => item.id), second.selected.map((item) => item.id));
  assert.deepEqual(first.selected.map((item) => item.id), ["1"]);
});

test("tokenizer supports usage anchor and fallback", () => {
  assert.equal(new ProviderUsageSkillTokenizer(new HeuristicSkillTokenizer(), () => 42).count("anything"), 42);
  assert.equal(new ProviderUsageSkillTokenizer(new HeuristicSkillTokenizer(), () => undefined).count("中文"), 2);
});

test("skill cache invalidates signatures", () => {
  const cache = new SkillCache();
  const value = snapshot([]);
  cache.set("cwd", "sig1", value);
  assert.equal(cache.get("cwd", "sig1"), value);
  assert.equal(cache.get("cwd", "sig2"), undefined);
  cache.invalidate("cwd");
  assert.equal(cache.size(), 0);
});

test("remote provider isolates list/read/execute contract", async () => {
  const provider = new RemoteSkillProvider("mcp-demo", "mcp", {
    async list() { return [{ locator: "remote://demo", name: "demo", description: "remote demo", bodyHash: "h" }]; },
    async read(request) { return `body:${request.locator}`; },
    async execute(request) { return { toolName: "remote", output: JSON.stringify(request.input ?? {}) }; },
  });
  const listed = await provider.list();
  assert.equal(listed[0].providerId, "mcp-demo");
  assert.equal(await provider.read("remote://demo"), "body:remote://demo");
  assert.equal((await provider.execute!({ locator: "remote://demo", input: { ok: true } })).isError, undefined);
});

test("marketplace validates hash, trust, authorization, and contained paths", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = { "SKILL.md": "---\nname: demo\ndescription: demo\n---\nbody" };
  const contentHash = "bad";
  const response = { ok: true, status: 200, async json() { return { manifest: { id: "demo", version: "1", contentHash }, files }; } } as Response;
  const client = new MarketplaceClient({ fetcher: async () => response, trust: () => true });
  await assert.rejects(() => client.install("https://example.invalid/demo", root), /contentHash/);
  const denied = new MarketplaceClient({ fetcher: async () => ({ ...response, async json() { return { manifest: { id: "demo", version: "1" }, files }; } } as Response), requireHash: false, authorizeInstall: () => false });
  await assert.rejects(() => denied.install("https://example.invalid/demo", root), /未获授权/);
  assert.equal((await fs.readdir(root)).length, 0);
});

test("plugin manager ignores malformed manifests and loads valid ones", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "valid"), { recursive: true });
  await fs.writeFile(path.join(root, "valid", "plugin.json"), JSON.stringify({ id: "demo", version: "1" }), "utf8");
  await fs.writeFile(path.join(root, "invalid.json"), "{}", "utf8");
  const manager = new SkillPluginManager([root]);
  assert.deepEqual((await manager.load()).map((item) => item.id), ["demo"]);
});

test("embedding selector performs semantic selection and persists candidate vectors", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const client = { model: "test-embedding", async embed(input: readonly string[]) { calls += 1; return input.map((text) => text.includes("database") ? [1, 0] : [0, 1]); } };
  const cachePath = path.join(root, "embedding.json");
  const skills = [metadata("db", "database", "database migrations"), metadata("ui", "frontend", "web interface")];
  const first = await new EmbeddingSkillSelector(client, { threshold: 0.5, cache: new PersistentEmbeddingCache(cachePath) }).select("database", skills);
  assert.equal(first.selected[0].id, "db");
  assert.equal(calls, 2);
  calls = 0;
  await new EmbeddingSkillSelector(client, { threshold: 0.5, cache: new PersistentEmbeddingCache(cachePath) }).select("database", skills);
  assert.equal(calls, 1, "candidate embeddings must come from the persisted cache");
});

test("tiktoken counts using the configured model encoding", () => {
  const tokenizer = new TiktokenSkillTokenizer();
  assert.ok(tokenizer.count("hello world", "gpt-4o") > 0);
  assert.equal(tokenizer.describe().modelMatched, true);
  tokenizer.count("hello", "provider-unknown-model");
  assert.equal(tokenizer.describe().modelMatched, false);
});

test("MCP provider connects over stdio, reads resources, and calls tools", async (t) => {
  const fixture = path.resolve("tests", "fixtures", "mcp-skill-server.mjs");
  const provider = new McpSkillProvider("fixture", { server: { transport: "stdio", command: process.execPath, args: [fixture], timeoutMs: 5_000 } });
  t.after(() => provider.close());
  const skills = await provider.list();
  assert.deepEqual(skills.map((skill) => skill.canonicalPath), ["skill://guide"]);
  assert.equal(await provider.read("skill://guide"), "MCP_SKILL_BODY");
  assert.equal((await provider.execute({ locator: "echo" })).output, "MCP_TOOL_OK");
  assert.equal(provider.connectionState, "ready");
  const registrations = await mcpToolRegistrations([provider]);
  assert.equal(qualifiedName(registrations[0].spec), "mcp.fixture.echo");
});

test("MCP elicitation pauses a real tool call until the broker resolves it", async (t) => {
  const fixture = path.resolve("tests", "fixtures", "mcp-skill-server.mjs");
  const broker = new McpElicitationBroker(undefined, 5_000);
  const provider = new McpSkillProvider("elicitation", { server: { transport: "stdio", command: process.execPath, args: [fixture], timeoutMs: 5_000 }, elicitationBroker: broker });
  t.after(() => provider.close());
  const running = provider.execute({ locator: "ask" });
  for (let attempt = 0; attempt < 100 && broker.list().length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const request = broker.list()[0]; assert.ok(request); assert.equal(request.message, "Provide a value");
  broker.resolve(request.id, { action: "accept", content: { value: "approved" } });
  const result = await running; assert.equal(result.isError, false); assert.match(result.output, /approved/);
  await broker.close();
});

test("MCP OAuth authorization-code flow uses PKCE, state and durable credentials", async (t) => {
  const root = await makeWorkspace(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests: Array<{ body: string; auth?: string }> = [];
  const server = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    requests.push({ body, auth: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ access_token: "oauth-access-token", token_type: "Bearer", expires_in: 3600, scope: "skills" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const store = new McpCredentialStore(path.join(root, "mcp-credentials.json"));
  const oauth = { grantType: "authorization_code" as const, clientId: "client", authorizationUrl: "https://auth.invalid/authorize", tokenUrl: `http://127.0.0.1:${port}/token`, redirectUri: "http://127.0.0.1/callback", scopes: ["skills"] };
  try {
    const transaction = await store.beginAuthorization("secure", oauth);
    assert.equal(transaction.verifier, "<redacted>");
    const authorization = new URL(transaction.authorizationUrl);
    assert.equal(authorization.searchParams.get("response_type"), "code");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorization.searchParams.get("code_challenge"));
    const credential = await store.completeAuthorization(transaction.id, "auth-code", transaction.state, oauth);
    assert.equal(credential.accessToken, "<redacted>");
    assert.match(requests[0].body, /grant_type=authorization_code/); assert.match(requests[0].body, /code_verifier=/);
    const reloaded = new McpCredentialStore(path.join(root, "mcp-credentials.json"));
    assert.equal((await reloaded.get("secure"))?.accessToken, "oauth-access-token");
    await assert.rejects(() => store.completeAuthorization(transaction.id, "auth-code", transaction.state, oauth), /不存在或已过期/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("MCP OAuth refresh rotates access credentials without exposing the refresh token", async (t) => {
  const root = await makeWorkspace(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let refreshRequest = "";
  const server = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk); refreshRequest = body;
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const tokenUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
  const store = new McpCredentialStore(path.join(root, "credentials.json"));
  const oauth = { grantType: "authorization_code" as const, clientId: "client", tokenUrl };
  try {
    await store.set("secure", { accessToken: "expired", refreshToken: "old-refresh", expiresAt: Date.now() - 1 });
    const refreshed = await store.refresh("secure", oauth);
    assert.equal(refreshed?.accessToken, "rotated-access");
    assert.match(refreshRequest, /grant_type=refresh_token/); assert.match(refreshRequest, /refresh_token=old-refresh/);
    assert.equal((await store.get("secure"))?.refreshToken, "rotated-refresh");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("plugin lifecycle installs atomically, resolves versions, disables and uninstalls", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const documents = new Map([
    ["https://plugins/v1", { manifest: { id: "demo", version: "1.0.0" }, files: { "SKILL.md": "v1" } }],
    ["https://plugins/v2", { manifest: { id: "demo", version: "2.0.0" }, files: { "SKILL.md": "v2" } }],
  ]);
  const fetcher = async (url: string | URL | Request) => ({ ok: true, status: 200, async json() { return documents.get(String(url)); } }) as Response;
  const marketplace = new MarketplaceClient({ fetcher: fetcher as typeof fetch, requireHash: false });
  const lifecycle = new PluginLifecycleManager(root, path.join(root, "registry.json"), marketplace);
  await lifecycle.install("https://plugins/v1");
  await lifecycle.install("https://plugins/v2");
  assert.equal(lifecycle.list()[0].activeVersion, "2.0.0");
  await lifecycle.disable("demo"); assert.deepEqual(lifecycle.activeRoots(), []);
  await lifecycle.enable("demo"); assert.equal(lifecycle.activeRoots().length, 1);
  await lifecycle.uninstall("demo", "2.0.0"); assert.equal(lifecycle.list()[0].activeVersion, "1.0.0");
  const index = new MarketplaceIndex(fetcher as typeof fetch);
  const entries = await index.search(["https://index"], "demo").catch(() => []);
  assert.deepEqual(entries, []);
});

test("Skill scripts require contained files and execute through ToolRouter", async (t) => {
  const root = await makeWorkspace();
  const ctx = await makeContext(root);
  t.after(() => cleanupContext(ctx));
  const skillRoot = path.join(root, ".agents", "skills", "scripted");
  await fs.mkdir(path.join(skillRoot, "agents"), { recursive: true });
  await fs.mkdir(path.join(skillRoot, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: scripted\ndescription: scripted skill\n---\nbody", "utf8");
  await fs.writeFile(path.join(skillRoot, "scripts", "run.mjs"), "process.stdout.write(process.env.SWE_SKILL_INPUT_JSON ?? '')", "utf8");
  await fs.writeFile(path.join(skillRoot, "agents", "openai.yaml"), "scripts:\n  - name: run\n    description: Run script\n    path: scripts/run.mjs\n    cwd: .\n", "utf8");
  const definitions = skillScriptDefinitions(loadSkillSnapshot(root));
  assert.equal(definitions.length, 1);
  const registration = new SkillScriptAdapter(runSkillScript).registration(definitions[0]);
  ctx.registry.registerDefinition(registration);
  const result = await new ToolRouter().route({ type: "tool_call", toolName: qualifiedName(registration.spec), toolInput: { value: 7 } }, ctx, { callId: "skill-script", signal: new AbortController().signal });
  assert.equal(result.isError, false, result.output);
  assert.match(result.output, /"value":7/);
  assert.ok(ctx.auditTrail.list().some((record) => record.callId === "skill-script" && record.phase === "execution" && record.success));

  await fs.writeFile(path.join(skillRoot, "agents", "openai.yaml"), "scripts:\n  - name: bad\n    description: Bad script\n    path: ../outside.mjs\n", "utf8");
  const invalid = loadSkillSnapshot(root);
  assert.equal(invalid.skills[0].scripts, undefined);
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.code === "invalid_skill_metadata"));
});

test("local watcher invalidation refreshes only the changed Skill directory", async (t) => {
  const root = await makeWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, ".agents", "skills");
  for (const [name, body] of [["one", "ONE"], ["two", "TWO"]] as const) {
    const directory = path.join(skillsRoot, name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`, "utf8");
  }
  const provider = new LocalSkillProvider("local", root, { projectRoot: root, repoRoots: [skillsRoot], includeCodexCompatibilityRoot: false, cacheTtlMs: 60_000 });
  const first = await provider.list();
  assert.equal(first.length, 2);
  const changed = path.join(skillsRoot, "one", "SKILL.md");
  await fs.writeFile(changed, "---\nname: one\ndescription: one skill\n---\nONE_CHANGED", "utf8");
  await provider.invalidate(skillsRoot, changed);
  const second = await provider.list();
  assert.equal(second.find((skill) => skill.name === "one")?.body.endsWith("ONE_CHANGED"), true);
  assert.equal(second.find((skill) => skill.name === "two")?.body.endsWith("TWO"), true);
  await fs.rm(path.join(skillsRoot, "two", "SKILL.md"));
  await provider.invalidate(skillsRoot, path.join(skillsRoot, "two", "SKILL.md"));
  assert.deepEqual((await provider.list()).map((skill) => skill.name), ["one"]);
});
