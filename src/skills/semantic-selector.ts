import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SkillMetadata } from "../config/skills.js";
import type { SemanticSelectionResult, SkillSelectionCandidate } from "./platform.js";

export interface EmbeddingClient {
  readonly model: string;
  embed(input: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;
}

export interface OpenAIEmbeddingClientOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  batchSize?: number;
  fetcher?: typeof fetch;
}

export class OpenAIEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAIEmbeddingClientOptions) {
    this.model = options.model;
    this.endpoint = embeddingEndpoint(options.baseUrl);
    this.fetcher = options.fetcher ?? fetch;
  }

  async embed(input: readonly string[], signal?: AbortSignal): Promise<readonly number[][]> {
    if (input.length === 0) return [];
    const size = Math.max(1, Math.min(256, this.options.batchSize ?? 64));
    const batches: string[][] = [];
    for (let index = 0; index < input.length; index += size) batches.push(input.slice(index, index + size) as string[]);
    const output: number[][] = [];
    for (const batch of batches) output.push(...await this.request(batch, signal));
    return output;
  }

  private async request(input: readonly string[], parentSignal?: AbortSignal): Promise<number[][]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= (this.options.maxRetries ?? 2); attempt += 1) {
      const controller = new AbortController();
      const relay = () => controller.abort(parentSignal?.reason ?? new Error("embedding request cancelled"));
      if (parentSignal?.aborted) relay(); else parentSignal?.addEventListener("abort", relay, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("embedding request timeout")), this.options.timeoutMs ?? 15_000);
      try {
        const response = await this.fetcher(this.endpoint, {
          method: "POST", signal: controller.signal,
          headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
          body: JSON.stringify({ model: this.model, input }),
        });
        if (!response.ok) throw new Error(`embedding request failed (${response.status})`);
        const payload: unknown = await response.json();
        const data = parseEmbeddingResponse(payload, input.length);
        return data;
      } catch (error) {
        lastError = controller.signal.aborted ? controller.signal.reason : error;
        if (parentSignal?.aborted || attempt >= (this.options.maxRetries ?? 2)) throw lastError;
        await delay(Math.min(1_000, 100 * 2 ** attempt), parentSignal);
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", relay);
      }
    }
    throw lastError;
  }
}

export class PersistentEmbeddingCache {
  private readonly values = new Map<string, number[]>();
  private loaded = false;
  constructor(private readonly filePath?: string, private readonly maxEntries = 10_000) {}

  async get(key: string): Promise<readonly number[] | undefined> { await this.load(); return this.values.get(key); }
  async set(key: string, value: readonly number[]): Promise<void> {
    await this.load();
    this.values.delete(key);
    this.values.set(key, [...value]);
    while (this.values.size > this.maxEntries) this.values.delete(this.values.keys().next().value!);
    await this.flush();
  }
  size(): number { return this.values.size; }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) if (Array.isArray(value) && value.every(Number.isFinite)) this.values.set(key, value as number[]);
      }
    } catch (error) {
      if (!isNodeCode(error, "ENOENT")) throw error;
    }
  }
  private async flush(): Promise<void> {
    if (!this.filePath) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(Object.fromEntries(this.values)), "utf8");
    await fs.rename(temporary, this.filePath);
  }
}

export interface EmbeddingSkillSelectorOptions {
  threshold?: number;
  maxResults?: number;
  mode?: "embedding" | "hybrid";
  cache?: PersistentEmbeddingCache;
}

export class EmbeddingSkillSelector {
  private readonly cache: PersistentEmbeddingCache;
  constructor(private readonly client: EmbeddingClient, private readonly options: EmbeddingSkillSelectorOptions = {}) {
    this.cache = options.cache ?? new PersistentEmbeddingCache();
  }

  async select(query: string, skills: readonly SkillMetadata[], signal?: AbortSignal): Promise<SemanticSelectionResult> {
    const eligible = skills.filter((skill) => skill.enabled && skill.allowImplicitInvocation);
    if (!query.trim() || eligible.length === 0) return { selected: [], candidates: [], ambiguous: false };
    const queryVector = (await this.client.embed([query], signal))[0];
    const vectors = await this.skillVectors(eligible, signal);
    const queryTerms = terms(query);
    const candidates: SkillSelectionCandidate[] = eligible.map((skill, index) => {
      const semantic = cosine(queryVector, vectors[index]);
      const lexical = lexicalScore(queryTerms, `${skill.name} ${skill.description} ${skill.interface?.defaultPrompt ?? ""}`);
      const score = this.options.mode === "hybrid" ? semantic * 0.75 + lexical * 0.25 : semantic;
      return { skill, score, matchedTerms: queryTerms.filter((term) => terms(`${skill.name} ${skill.description}`).includes(term)) };
    }).filter((candidate) => candidate.score >= (this.options.threshold ?? 0.72))
      .sort((a, b) => b.score - a.score || identity(a.skill).localeCompare(identity(b.skill)));
    const selected = candidates.slice(0, Math.max(1, this.options.maxResults ?? 1)).map((candidate) => candidate.skill);
    const ambiguous = candidates.length > 1 && Math.abs(candidates[0].score - candidates[1].score) < 0.015;
    return { selected: ambiguous ? [] : selected, candidates, ambiguous };
  }

  private async skillVectors(skills: readonly SkillMetadata[], signal?: AbortSignal): Promise<number[][]> {
    const result: Array<number[] | undefined> = new Array(skills.length);
    const misses: Array<{ index: number; key: string; text: string }> = [];
    for (let index = 0; index < skills.length; index += 1) {
      const skill = skills[index];
      const text = `${skill.name}\n${skill.description}\n${skill.interface?.defaultPrompt ?? ""}`;
      const key = digest(`${this.client.model}\0${skill.id}\0${skill.bodyHash}\0${text}`);
      const cached = await this.cache.get(key);
      if (cached) result[index] = [...cached]; else misses.push({ index, key, text });
    }
    if (misses.length > 0) {
      const embedded = await this.client.embed(misses.map((item) => item.text), signal);
      for (let index = 0; index < misses.length; index += 1) {
        const miss = misses[index];
        result[miss.index] = [...embedded[index]];
        await this.cache.set(miss.key, embedded[index]);
      }
    }
    return result as number[][];
  }
}

function embeddingEndpoint(baseUrl: string): string {
  const value = baseUrl.replace(/\/+$/, "");
  return value.endsWith("/embeddings") ? value : `${value}/embeddings`;
}
function parseEmbeddingResponse(value: unknown, expected: number): number[][] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) throw new Error("embedding response missing data");
  const rows = (value as { data: unknown[] }).data.map((item) => {
    if (!item || typeof item !== "object" || !Array.isArray((item as { embedding?: unknown }).embedding) || !(item as { embedding: unknown[] }).embedding.every(Number.isFinite)) throw new Error("embedding response contains invalid vector");
    return { index: typeof (item as { index?: unknown }).index === "number" ? (item as { index: number }).index : 0, vector: (item as { embedding: number[] }).embedding };
  }).sort((a, b) => a.index - b.index);
  if (rows.length !== expected || rows.some((row) => row.vector.length === 0)) throw new Error("embedding response count mismatch");
  const dimensions = rows[0].vector.length;
  if (rows.some((row) => row.vector.length !== dimensions)) throw new Error("embedding vector dimensions mismatch");
  return rows.map((row) => row.vector);
}
function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) throw new Error("embedding vector dimensions mismatch");
  let dot = 0; let a = 0; let b = 0;
  for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; a += left[index] ** 2; b += right[index] ** 2; }
  return a === 0 || b === 0 ? 0 : dot / Math.sqrt(a * b);
}
function lexicalScore(query: readonly string[], value: string): number {
  if (query.length === 0) return 0;
  const available = terms(value);
  return query.filter((term) => available.includes(term)).length / query.length;
}
function terms(value: string): string[] { return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1))]; }
function identity(skill: SkillMetadata): string { return `${skill.providerId ?? "local"}:${skill.canonicalPath}`; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isNodeCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code; }
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("cancelled")); };
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}
