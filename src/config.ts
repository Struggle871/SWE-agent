import type { AgentConfig } from "./types.js";

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  // 自动加载项目根目录下的 .env（若存在）；Node 20.12+ 提供 process.loadEnvFile
  try {
    process.loadEnvFile();
  } catch {
    /* 没有 .env 时使用当前环境变量 */
  }

  const env = process.env;

  const useFakeEnv = env.USE_FAKE_MODEL?.trim().toLowerCase();
  const useFakeModel = useFakeEnv ? useFakeEnv === "true" : !env.MODEL_API_KEY;

  const config: AgentConfig = {
    maxSteps: Number(env.MAX_STEPS ?? 20),
    maxContextTokens: Number(env.MAX_CONTEXT_TOKENS ?? 8000),
    maxOutputTokens: Number(env.MAX_OUTPUT_TOKENS ?? 2048),
    toolTimeoutMs: Number(env.TOOL_TIMEOUT_MS ?? 30000),
    parseRetry: Number(env.PARSE_RETRY ?? 2),
    workspaceRoot: env.WORKSPACE_ROOT ?? process.cwd(),
    model: {
      baseUrl: env.MODEL_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
      apiKey: env.MODEL_API_KEY,
      model: env.MODEL_NAME ?? "glm-4.7-flash",
    },
    useFakeModel,
    useLlmPlanning: (env.USE_LLM_PLANNING ?? "false").trim().toLowerCase() === "true",
    compaction: {
      backend: parseBackend(env.COMPACTION_BACKEND),
      autoCompactTokenLimit: Number(env.AUTO_COMPACT_TOKEN_LIMIT ?? Math.floor(Number(env.MAX_CONTEXT_TOKENS ?? 8000) * 0.8)),
      limitScope: env.AUTO_COMPACT_LIMIT_SCOPE === "body_after_prefix" ? "body_after_prefix" : "total",
      fallbackBufferTokens: Number(env.COMPACTION_FALLBACK_BUFFER_TOKENS ?? 512),
      timeoutMs: Number(env.COMPACTION_TIMEOUT_MS ?? 60_000),
      maxRetries: Number(env.COMPACTION_MAX_RETRIES ?? 2),
      maxRetainedUserTokens: Number(env.COMPACTION_MAX_RETAINED_USER_TOKENS ?? 2_000),
      maxCheckpointItems: Number(env.COMPACTION_MAX_CHECKPOINT_ITEMS ?? 1_000),
      maxCheckpointBytes: Number(env.COMPACTION_MAX_CHECKPOINT_BYTES ?? 2_000_000),
      maxItemBytes: Number(env.COMPACTION_MAX_ITEM_BYTES ?? 256_000),
      ...(env.COMPACTION_PROMPT ? { prompt: env.COMPACTION_PROMPT } : {}),
    },
  };

  return { ...config, ...overrides };
}

function parseBackend(value: string | undefined): "auto" | "local" | "remote" | "remote_v2" | "new_context" {
  return value === "local" || value === "remote" || value === "remote_v2" || value === "new_context" ? value : "auto";
}
