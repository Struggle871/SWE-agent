import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "./events.js";

export interface MetricSample { name: string; value: number; timestamp: number; labels: Record<string, string> }
export interface EventSample { cursor: number; timestamp: number; type: AgentEvent["type"]; event: AgentEvent }

/** Bounded live metrics plus an optional durable SQLite event projection. */
export interface ObservabilityOptions { inputCostPer1k?: number; outputCostPer1k?: number }
export class Observability {
  private readonly samples: MetricSample[] = [];
  private readonly db?: DatabaseSync;
  private cursor = 0;
  private readonly turnStarted = new Map<string, number>();
  private readonly toolStarted = new Map<string, number>();
  private readonly modelStarted = new Map<string, { timestamp: number; firstOutput: boolean; sessionId?: string }>();
  private readonly activeRequestByStep = new Map<string, string>();
  private readonly compactionStarted = new Map<string, number>();
  constructor(private readonly maxSamples = 10_000, filePath?: string, private readonly pricing: ObservabilityOptions = {}) {
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.db = new DatabaseSync(filePath);
      this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, type TEXT NOT NULL, event_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, labels_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_events_type_cursor ON events(type,cursor); CREATE INDEX IF NOT EXISTS idx_metrics_name_timestamp ON metrics(name,timestamp)");
      const row = this.db.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM events").get() as { cursor: number };
      this.cursor = row.cursor;
    }
  }
  record(name: string, value: number, labels: Record<string, string> = {}): void {
    const sample = { name, value, timestamp: Date.now(), labels };
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
    this.db?.prepare("INSERT INTO metrics(timestamp,name,value,labels_json) VALUES(?,?,?,?)").run(sample.timestamp, name, value, JSON.stringify(labels));
  }
  onEvent(event: AgentEvent): void {
    const timestamp = Date.now();
    if (this.db) {
      const result = this.db.prepare("INSERT INTO events(timestamp,type,event_json) VALUES(?,?,?)").run(timestamp, event.type, JSON.stringify(safeEvent(event)));
      this.cursor = Number(result.lastInsertRowid);
    } else this.cursor += 1;
    if (event.type === "turn_started") this.turnStarted.set(event.turnId, timestamp);
    if (event.type === "turn_completed") {
      this.record("turn.completed", 1, { reason: event.reason });
      const started = this.turnStarted.get(event.turnId); if (started !== undefined) this.record("turn.duration_ms", timestamp - started, { reason: event.reason, sessionId: event.sessionId, turnId: event.turnId });
      this.turnStarted.delete(event.turnId);
    }
    if (event.type === "turn_aborted") this.record("turn.aborted", 1);
    if (event.type === "tool_use_started") this.toolStarted.set(event.callId, timestamp);
    if (event.type === "tool_use_completed") {
      this.record("tool.completed", 1, { tool: event.toolName, error: String(event.isError), callId: event.callId });
      const started = this.toolStarted.get(event.callId); if (started !== undefined) this.record("tool.duration_ms", timestamp - started, { tool: event.toolName, callId: event.callId });
      this.toolStarted.delete(event.callId);
    }
    if (event.type === "compaction") {
      this.record(`compaction.${event.status}`, 1, { reason: event.reason });
      if (event.status === "started") this.compactionStarted.set(event.compactionId, timestamp);
      else { const started = this.compactionStarted.get(event.compactionId); if (started !== undefined) this.record("compaction.duration_ms", timestamp - started, { status: event.status, reason: event.reason }); this.compactionStarted.delete(event.compactionId); }
    }
    if (event.type === "subagent_started") this.record("subagent.started", 1);
    if (event.type === "subagent_completed") this.record(`subagent.${event.status}`, 1);
    if (event.type === "approval_requested") this.record("approval.requested", 1, { risk: event.request.preview.risk });
    if (event.type === "approval_resolved") this.record(event.result.approved ? "approval.approved" : "approval.denied", 1, { scope: event.result.scope });
    if (event.type === "api_error") {
      this.record("api.error", 1, { recoverable: String(event.recoverable) });
      if (/sandbox|沙箱|workspace cwd|filesystem boundary/i.test(event.error.message)) this.record("sandbox.violation", 1);
    }
    if (event.type === "tool_preview") this.record("tool.preview", 1, { risk: event.preview.risk, tool: event.preview.toolName });
    if (event.type === "model_event") this.observeModelEvent(event, timestamp);
  }
  list(): readonly MetricSample[] {
    if (!this.db) return this.samples.map((sample) => ({ ...sample, labels: { ...sample.labels } }));
    const rows = this.db.prepare("SELECT name,value,timestamp,labels_json as labelsJson FROM metrics ORDER BY id DESC LIMIT ?").all(this.maxSamples) as unknown as Array<{ name: string; value: number; timestamp: number; labelsJson: string }>;
    return rows.reverse().map((row) => ({ name: row.name, value: row.value, timestamp: row.timestamp, labels: JSON.parse(row.labelsJson) as Record<string, string> }));
  }
  events(after = 0, limit = 100): EventSample[] {
    if (!this.db) return [];
    const rows = this.db.prepare("SELECT cursor,timestamp,type,event_json as eventJson FROM events WHERE cursor > ? ORDER BY cursor LIMIT ?").all(after, Math.min(Math.max(limit, 1), 500)) as unknown as Array<{ cursor: number; timestamp: number; type: AgentEvent["type"]; eventJson: string }>;
    return rows.map((row) => ({ cursor: row.cursor, timestamp: row.timestamp, type: row.type, event: JSON.parse(row.eventJson) as AgentEvent }));
  }
  get currentCursor(): number { return this.cursor; }
  eventBounds(): { oldest: number; latest: number } {
    if (!this.db) return { oldest: Math.max(0, this.cursor), latest: this.cursor };
    const row = this.db.prepare("SELECT COALESCE(MIN(cursor), 0) AS oldest, COALESCE(MAX(cursor), 0) AS latest FROM events").get() as { oldest: number; latest: number };
    return row;
  }
  close(): void { this.db?.close(); }

  private observeModelEvent(event: Extract<AgentEvent, { type: "model_event" }>, timestamp: number): void {
    const model = event.event;
    const stepKey = `${event.sessionId ?? ""}:${event.turnId ?? ""}:${event.stepId ?? ""}`;
    if (model.type === "response_started") {
      this.modelStarted.set(model.requestId, { timestamp, firstOutput: false, ...(event.sessionId ? { sessionId: event.sessionId } : {}) });
      this.activeRequestByStep.set(stepKey, model.requestId);
      return;
    }
    const requestId = model.type === "usage" && model.requestId ? model.requestId : this.activeRequestByStep.get(stepKey);
    if (requestId && ["text_delta", "reasoning_delta", "tool_call_started"].includes(model.type)) {
      const started = this.modelStarted.get(requestId);
      if (started && !started.firstOutput) { started.firstOutput = true; this.record("model.ttft_ms", timestamp - started.timestamp, { requestId, ...(started.sessionId ? { sessionId: started.sessionId } : {}) }); }
    }
    if (model.type === "usage") {
      const labels: Record<string, string> = requestId ? { requestId } : {};
      this.record("model.input_tokens", model.usage.inputTokens, labels); this.record("model.output_tokens", model.usage.outputTokens, labels);
      if (model.usage.cachedInputTokens !== undefined) this.record("model.cached_input_tokens", model.usage.cachedInputTokens, labels);
      const inputRate = this.pricing.inputCostPer1k ?? 0; const outputRate = this.pricing.outputCostPer1k ?? 0;
      if (inputRate > 0 || outputRate > 0) this.record("model.cost", (model.usage.inputTokens / 1000) * inputRate + (model.usage.outputTokens / 1000) * outputRate, labels);
    }
    if (model.type === "transport_warning") this.record("model.retry_or_warning", 1, { recoverable: String(model.recoverable) });
    if (model.type === "response_completed" && requestId) {
      const started = this.modelStarted.get(requestId); if (started) this.record("model.latency_ms", timestamp - started.timestamp, { requestId, finishReason: model.finishReason });
      this.modelStarted.delete(requestId); this.activeRequestByStep.delete(stepKey);
    }
  }
}

function safeEvent(event: AgentEvent): Record<string, unknown> {
  const value = event as unknown as Record<string, unknown>;
  if (event.type === "stream_delta") return { type: event.type };
  if (event.type === "model_event") return { type: event.type, sessionId: event.sessionId, turnId: event.turnId, stepId: event.stepId, modelEvent: event.event.type, ...(event.event.type === "response_started" ? { requestId: event.event.requestId } : {}), ...(event.event.type === "usage" ? { requestId: event.event.requestId, usage: event.event.usage } : {}), ...(event.event.type === "response_completed" ? { finishReason: event.event.finishReason } : {}) };
  if (event.type === "response_item") return { type: event.type, sessionId: event.sessionId, turnId: event.turnId, stepId: event.stepId, itemId: event.item.id, role: event.item.message.role, metadata: event.item.metadata };
  if (event.type === "api_error") return { type: event.type, recoverable: event.recoverable, error: event.error.message.slice(0, 1_000) };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item instanceof Error ? { name: item.name, message: item.message.slice(0, 1_000) } : typeof item === "string" ? item.slice(0, 4_000) : item]));
}
