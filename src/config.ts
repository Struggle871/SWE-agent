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
  };

  return { ...config, ...overrides };
}