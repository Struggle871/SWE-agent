// 分层配置：builtin < user(~/.swe-agent/config.toml) < project(./.swe-agent/config.toml) < local(.env/CLI)
// 对齐 Claude Code / Codex 的分层配置模型。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig } from "../types.js";
import { loadConfig } from "../config.js";
import { parseToml } from "./toml.js";

export type AgentConfigPatch = Partial<Omit<AgentConfig, "model">> & {
  model?: Partial<AgentConfig["model"]>;
};

export interface ConfigLayer {
  source: "builtin" | "user" | "project" | "local";
  values: AgentConfigPatch;
}

export async function loadLayeredConfig(overrides: AgentConfigPatch = {}): Promise<AgentConfig> {
  const layers: ConfigLayer[] = [{ source: "builtin", values: builtinConfig() }];

  const user = readTomlLayer(path.join(os.homedir(), ".swe-agent", "config.toml"), "user");
  if (user) layers.push(user);

  const project = readTomlLayer(path.join(process.cwd(), ".swe-agent", "config.toml"), "project");
  if (project) layers.push(project);

  // local 层：.env + 环境变量 + CLI 覆盖（含 useFakeModel 推导）
  const local = loadConfig(overrides as Partial<AgentConfig>);
  layers.push({ source: "local", values: local });

  return mergeLayers(layers);
}

function builtinConfig(): AgentConfigPatch {
  return {
    maxSteps: 20,
    maxContextTokens: 8000,
    maxOutputTokens: 2048,
    toolTimeoutMs: 30000,
    parseRetry: 2,
    model: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7-flash" },
    useLlmPlanning: false,
  };
}

function readTomlLayer(file: string, source: "user" | "project"): ConfigLayer | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = parseToml(fs.readFileSync(file, "utf8"));
    return { source, values: tomlToConfig(parsed) };
  } catch (e) {
    console.warn(`[config] 读取配置失败 ${file}: ${String(e)}`);
    return null;
  }
}

function tomlToConfig(parsed: Record<string, unknown>): AgentConfigPatch {
  const out: AgentConfigPatch = {};
  const n = (v: unknown) => (typeof v === "number" ? v : undefined);
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  const b = (v: unknown) => (typeof v === "boolean" ? v : undefined);

  if (n(parsed.max_steps) !== undefined) out.maxSteps = n(parsed.max_steps);
  if (n(parsed.max_context_tokens) !== undefined) out.maxContextTokens = n(parsed.max_context_tokens);
  if (n(parsed.max_output_tokens) !== undefined) out.maxOutputTokens = n(parsed.max_output_tokens);
  if (n(parsed.tool_timeout_ms) !== undefined) out.toolTimeoutMs = n(parsed.tool_timeout_ms);
  if (n(parsed.parse_retry) !== undefined) out.parseRetry = n(parsed.parse_retry);
  if (s(parsed.workspace_root) !== undefined) out.workspaceRoot = s(parsed.workspace_root);
  if (b(parsed.use_llm_planning) !== undefined) out.useLlmPlanning = b(parsed.use_llm_planning);

  const m = parsed.model as Record<string, unknown> | undefined;
  if (m && typeof m === "object") {
    const modelPatch: Partial<AgentConfig["model"]> = {};
    if (s(m.base_url) !== undefined) modelPatch.baseUrl = s(m.base_url);
    if (s(m.api_key) !== undefined) modelPatch.apiKey = s(m.api_key);
    if (s(m.model) !== undefined) modelPatch.model = s(m.model);
    out.model = modelPatch;
  }

  return out;
}

function mergeLayers(layers: ConfigLayer[]): AgentConfig {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [key, val] of Object.entries(layer.values)) {
      if (val === undefined) continue;
      if (key === "model" && typeof val === "object" && val !== null) {
        merged.model = { ...(merged.model as object ?? {}), ...(val as object) };
      } else {
        merged[key] = val;
      }
    }
  }
  return merged as unknown as AgentConfig;
}
