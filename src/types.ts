import type { ToolRegistry } from "./tools/registry.js";
import type { ShellSession } from "./tools/terminal.js";
import type { FileStateCache } from "./core/file-state-cache.js";
import type { ApprovalBroker } from "./security/approval-broker.js";
import type { AuditTrail } from "./security/audit.js";
import type { CommandAnalyzer } from "./security/command-policy.js";
import type { PermissionPolicy } from "./security/permission-policy.js";
import type { WorkspacePolicy } from "./security/workspace-policy.js";
import type { SandboxProvider } from "./security/sandbox.js";
import type { ModelTransport } from "./protocol/model-events.js";
import type { CallId, RequestId, SessionId, StepId, TurnId } from "./protocol/ids.js";
import type { Usage as ProtocolUsage } from "./protocol/usage.js";
import type { TurnTerminalReason } from "./core/events.js";
import type { CanonicalMessage } from "./protocol/items.js";
import type { ContextFragment } from "./config/skills.js";
import type { InstructionSnapshot } from "./config/agents-md.js";
import type { SelectedSkill, SkillSnapshot } from "./config/skills.js";

export type Role = "system" | "developer" | "user" | "assistant" | "tool";

export type Usage = ProtocolUsage;

/** @deprecated Use ResponseItemEnvelope at protocol/context boundaries. */
export type Message = CanonicalMessage;

export type CompactionBackendPreference = "auto" | "local" | "remote" | "remote_v2" | "new_context";
export type AutoCompactTokenLimitScope = "total" | "body_after_prefix";

export interface CompactionConfig {
  backend: CompactionBackendPreference;
  autoCompactTokenLimit: number;
  limitScope: AutoCompactTokenLimitScope;
  fallbackBufferTokens: number;
  timeoutMs: number;
  maxRetries: number;
  maxRetainedUserTokens: number;
  maxCheckpointItems: number;
  maxCheckpointBytes: number;
  maxItemBytes: number;
  prompt?: string;
}

export interface ToolResult {
  toolName: string;
  output: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export type JsonSchema = {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
};

export type JsonSchemaProperty = {
  type: string;
  description?: string;
  items?: { type: string };
  enum?: string[];
  default?: unknown;
};

export type AgentAction =
  | { type: "tool_call"; thought?: string; toolName: string; toolInput: Record<string, unknown>; callId?: CallId }
  | { type: "final_answer"; thought?: string; answer: string };

export interface AgentStep {
  index: number;
  action: AgentAction;
  observation?: ToolResult;
  rawOutput: string;
  timestamp: number;
  sessionId?: SessionId;
  turnId?: TurnId;
  stepId?: StepId;
  requestId?: RequestId;
  usage?: Usage;
  reasoning?: string;
  finishReason?: string;
  continueReason?: import("./core/events.js").ContinueReason;
}

export interface Task {
  id: string;
  description: string;
  status: "pending" | "blocked" | "in_progress" | "completed" | "done" | "failed" | "retrying" | "cancelled";
  parentId?: string;
  dependsOn?: string[];
  ownerSessionId?: SessionId;
  acceptanceCriteria?: string[];
  attempts?: number;
  maxAttempts?: number;
  budget?: { maxSteps?: number; maxTokens?: number };
  resultSummary?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface CompletedTaskSummary {
  description: string;
  result: string;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  executionId?: string;
}

export interface AgentContext {
  config: AgentConfig;
  registry: ToolRegistry;
  shell: ShellSession;
  model: ModelClient;
  workspaceRoot: string;
  workingMemory: Record<string, unknown>;
  /** @deprecated Legacy JSON/ReAct-only prompt memory; M7 AGENTS use user-role contextual fragments. */
  agentMemories?: string;
  contextualFragments?: readonly ContextFragment[];
  configStack?: import("./config/layered-config.js").ConfigLayerStack;
  instructionSnapshot?: InstructionSnapshot;
  skillSnapshot?: SkillSnapshot;
  selectedSkills?: readonly SelectedSkill[];
  contextFileSystem?: import("./config/context-filesystem.js").ContextFileSystem;
  skillPlatform?: import("./skills/platform.js").SkillPlatform;
  /** Host-supplied model tokenizer; absent means explicit heuristic fallback. */
  skillTokenizer?: import("./skills/platform.js").SkillTokenizer;
  /** 文件状态缓存：记录已读文件内容与 mtime，用于「编辑前必须读取」校验 */
  fileStateCache: FileStateCache;
  workspacePolicy: WorkspacePolicy;
  commandAnalyzer: CommandAnalyzer;
  permissionPolicy: PermissionPolicy;
  approvalBroker: ApprovalBroker;
  auditTrail: AuditTrail;
  /** M3.5 runtime 的可替换沙箱；缺失时 run_command 必须拒绝执行。 */
  sandboxProvider?: SandboxProvider;
  /** M8 durable task graph shared by the session and task tools. */
  taskGraph?: import("./core/task-graph.js").TaskGraphStore;
  /** M8 local child-agent lifecycle and mailbox service. */
  agentManager?: import("./core/agent-manager.js").AgentManager;
  hooks?: import("./core/hook-engine.js").HookEngine;
  memoryStore?: import("./core/memory-store.js").MemoryStore;
  observability?: import("./core/observability.js").Observability;
  mcpProviders?: readonly import("./skills/mcp-provider.js").McpSkillProvider[];
  mcpManager?: import("./skills/mcp-manager.js").McpRuntimeManager;
  pluginLifecycle?: import("./skills/plugin-manager.js").PluginLifecycleManager;
  pluginActivation?: import("./skills/plugin-activation.js").PluginActivationManager;
  sessionId?: SessionId;
}

export interface AgentConfig {
  maxSteps: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  toolTimeoutMs: number;
  parseRetry: number;
  workspaceRoot: string;
  model: { baseUrl: string; apiKey?: string; model: string; inputCostPer1k?: number; outputCostPer1k?: number };
  useFakeModel: boolean;
  useLlmPlanning: boolean;
  sandboxMode?: "unavailable" | "best-effort" | "docker";
  networkAccess?: "deny" | "allow";
  compaction?: Partial<CompactionConfig>;
  agents?: AgentsConfig;
  skills?: SkillsConfig;
  configFingerprint?: string;
  requirementsFingerprint?: string;
  hooks?: HookConfig[];
}

export type HookEventName = "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PreCompact" | "PostCompact" | "PermissionRequest" | "Interrupt" | "Stop" | "SubagentStart" | "SubagentStop";
export interface HookConfig {
  id: string;
  event: HookEventName;
  command: string;
  args?: string[];
  matcher?: string;
  timeoutMs?: number;
  onTimeout?: "allow" | "block";
  onError?: "allow" | "block";
  trustedHash?: string;
}

export interface AgentsConfig {
  fallbackFilenames?: string[];
  projectRootMarkers?: string[];
  maxBytes?: number;
  projectTrusted?: boolean;
}

export interface SkillsConfig {
  repoRoots?: string[];
  userRoots?: string[];
  systemRoots?: string[];
  adminRoots?: string[];
  maxContextTokens?: number;
  maxSelectedBodyTokensPerSkill?: number;
  maxSelectedBodyTokensTotal?: number;
  enablement?: Record<string, boolean>;
  includeCodexCompatibilityRoot?: boolean;
  maxScanDepth?: number;
  maxEntriesPerRoot?: number;
  maxSkills?: number;
  implicitSelection?: boolean;
  selectorThreshold?: number;
  selectorMaxResults?: number;
  pluginRoots?: string[];
  installRoot?: string;
  marketplaceRequireHash?: boolean;
  watch?: boolean;
  scanConcurrency?: number;
  cacheTtlMs?: number;
  selectorMode?: "explicit" | "lexical" | "embedding" | "hybrid";
  embeddingModel?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  embeddingTimeoutMs?: number;
  products?: string[];
  marketplaceIndexes?: string[];
  mcpServers?: Record<string, SkillMcpServerConfig>;
  remoteProviders?: Record<string, SkillRemoteProviderConfig>;
}

export interface SkillRemoteProviderConfig {
  enabled?: boolean;
  kind: "executor" | "orchestrator";
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface SkillMcpServerConfig {
  enabled?: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  resourcePrefixes?: string[];
  oauth?: { tokenUrl?: string; authorizationUrl?: string; clientId: string; clientSecret?: string; scopes?: string[]; grantType?: "client_credentials" | "authorization_code"; redirectUri?: string };
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "done"; raw: string; usage?: Usage };

export interface ModelClient {
  chat(messages: Message[], options?: ChatOptions): Promise<string>;
  /** 流式接口（可选）：逐 token 输出，最终以 done 事件收尾 */
  stream?(messages: Message[], options?: ChatOptions): AsyncGenerator<ModelStreamEvent>;
  /** M2 provider-neutral 事件流；旧模型由 LegacyModelTransportAdapter 兼容。 */
  transport?: ModelTransport;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface AgentRunResult {
  answer: string;
  steps: number;
  history: Message[];
  taskTrace: AgentStep[];
  sessionId?: SessionId;
  turnId?: TurnId;
  terminalReason?: TurnTerminalReason;
}
