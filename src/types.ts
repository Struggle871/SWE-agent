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

export type Role = "system" | "user" | "assistant" | "tool";

export type Usage = ProtocolUsage;

export interface Message {
  role: Role;
  content: string;
  name?: string;
  usage?: Usage;
  requestId?: RequestId;
  toolCalls?: Array<{ callId: CallId; name: string; input: unknown }>;
  toolCallId?: CallId;
}

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
  continueReason?: import("./core/events.js").ContinueReason;
}

export interface Task {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "done" | "failed";
  parentId?: string;
  dependsOn?: string[];
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
}

export interface AgentContext {
  config: AgentConfig;
  registry: ToolRegistry;
  shell: ShellSession;
  model: ModelClient;
  workspaceRoot: string;
  workingMemory: Record<string, unknown>;
  /** CLAUDE.md / AGENTS.md 合并内容，注入 system prompt */
  agentMemories?: string;
  /** 文件状态缓存：记录已读文件内容与 mtime，用于「编辑前必须读取」校验 */
  fileStateCache: FileStateCache;
  workspacePolicy: WorkspacePolicy;
  commandAnalyzer: CommandAnalyzer;
  permissionPolicy: PermissionPolicy;
  approvalBroker: ApprovalBroker;
  auditTrail: AuditTrail;
  /** M3.5 runtime 的可替换沙箱；缺失时 run_command 必须拒绝执行。 */
  sandboxProvider?: SandboxProvider;
}

export interface AgentConfig {
  maxSteps: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  toolTimeoutMs: number;
  parseRetry: number;
  workspaceRoot: string;
  model: { baseUrl: string; apiKey?: string; model: string };
  useFakeModel: boolean;
  useLlmPlanning: boolean;
  compaction?: Partial<CompactionConfig>;
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
