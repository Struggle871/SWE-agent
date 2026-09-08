# minimal-swe-agent v2：Claude Code / Codex 对齐重构设计

> 版本：v2.0  
> 日期：2026-08-27  
> 适用仓库：`minimal-swe-agent`  
> 语言约束：TypeScript + `strict: true`
> 状态说明：第 0-2 节保留 v2 立项时的历史基线，不代表 2026-09-05 的实现状态。项目发布完成口径仍截至 M3.5；工作区已有 M4/M5 原型和通过专项验证的 M6 实现，但在 M4/M5 顺序验收完成前不改写整体里程碑状态。当前状态见 [README.md](../README.md)，M6 设计与实现证据见 [m6-context-checkpoint-compaction.md](./m6-context-checkpoint-compaction.md)。

## 0. 结论先行

本设计建立时，项目已有不少“名字正确”的模块，但它们大多仍是单进程 demo 级实现：`AgentSession` 虽然存在，实际仍把会话、轮次、任务、上下文和工具执行绑在一起；`StreamingToolExecutor` 只排队，不能消费流中的真实 tool call；`CompactionPipeline` 能压缩文本，却没有和持久化 transcript、上下文窗口、重建语义绑定；`ToolRegistry` 只有名称查找，缺少 Codex 风格的模型可见 spec、runtime、路由和生命周期；配置、权限、hooks、MCP、skills、resume、记忆和多 agent 尚未形成端到端闭环。后续 M0-M5 的完成情况不回写为本段的历史事实。

v2 不再以“在现有类上继续堆功能”为目标，而是把系统重构为以下稳定边界：

```text
Frontends (CLI / exec / JSON-RPC)
        |
SessionCoordinator  ----  SessionStore / RolloutWriter
        |
TurnStateMachine ---- ContextManager / CompactionManager
        |
ModelTransport ---- ResponseEventStream
        |
ToolRouter -> ToolRegistry -> ToolRuntime
        |                         |
  Approval / Hooks / Sandbox / MCP / Extensions
```

核心原则：

1. **Transcript 是唯一真源**。内存上下文、摘要、SQLite 索引、trace 都是可重建派生物。
2. **模型看到的工具和真正执行的工具分离**。工具 spec 可以裁剪、延迟暴露、按会话变更；runtime 必须由权限和沙箱再次校验。
3. **一次 session 只能有一个 active turn**，但 turn 内可以有多个 sampling request、并发只读工具、待处理用户输入和可取消任务。
4. **上下文压缩是协议事件，不是字符串截断**。压缩必须留下 checkpoint、窗口编号和可重放历史。
5. **所有写操作都经过安全决策**。路径保护、命令分析、approval policy、sandbox、hook 和用户确认是不同层，不能互相替代。
6. **事实和推断分开**。Codex 部分以下引用本地取得的公开源码；Claude Code 核心实现未公开，只采用其公开 CLI 契约和文档能力，不把社区逆向结论当成官方源码事实。

## 1. 研究边界与源码证据

### 1.1 Codex：已阅读的真实源码

本次使用的源码快照：

```text
tmp/openai-codex-source/
commit: 2c4a957 Expose response usage metadata in completion events (#41087)
```

Windows checkout 因路径长度问题有少量 snapshot 文件未落盘，但核心 Rust 源文件完整可读。关键证据如下：

- `codex-rs/core/src/session/session.rs`：`Session` 明确持有 `active_turn`、`InputQueue`、事件发送器、MCP/hook/service、fork 持久化和会话配置；注释写明一个 session 最多一个 running task，并可被用户输入中断。
- `codex-rs/core/src/session/turn.rs`：`run_turn` 在 turn 开始执行 pre-sampling compact，捕获 step context，循环执行 sampling request；以 `needs_follow_up`、pending input、token limit 和 auto-compact 决定继续、滚动窗口或结束。
- `codex-rs/core/src/session/turn.rs`：模型请求和工具结果按 turn 语义处理，工具调用完成后继续采样；失败按 `TurnAborted`、图片错误、普通 Codex error 等分支处理，而不是用一个大 try/catch 包住主循环。
- `codex-rs/core/src/tools/router.rs`：`ToolRouter` 持有独立的 `ToolRegistry` 和 `model_visible_specs`，负责从 response item 构造 `ToolCall`，并提供 `tool_supports_parallel`、runtime 查找和 dispatch。
- `codex-rs/core/src/tools/registry.rs`：runtime 同时承载 spec、hook payload、diff consumer、MCP server、telemetry 和结果适配；registry 执行 PreToolUse、PostToolUse、lifecycle 等横切逻辑。
- `codex-rs/core/src/tools/parallel.rs`：`ToolCallRuntime` 使用 `tokio::sync::RwLock`，可并行工具取读锁，不支持并行的工具取写锁；取消时中止任务并生成 aborted response。
- `codex-rs/core/src/tools/spec_plan.rs`：先加入 core/source/MCP/dynamic tools，再按 exposure（direct/deferred/code mode/hidden）构造 model-visible tool layout，存在冲突检测和工具搜索。
- `codex-rs/core/src/tools/handlers/apply_patch.rs` 与 `tools/runtimes/apply_patch.rs`：apply patch 先解析/验证/评估安全，再由 runtime 在选定 environment filesystem 和 sandbox context 中执行；支持流式参数 diff、审批和文件变更 delta。
- `codex-rs/core/src/compact.rs`：压缩是独立任务，有 `PreCompact`/`PostCompact` hook、手动和自动触发、replacement history、window ids 和初始上下文注入策略。
- `codex-rs/core/src/agents_md.rs`：按 project root markers 找根目录，从根到 cwd 收集层级 `AGENTS.md`，有候选文件名、来源 provenance 和总字节预算。
- `codex-rs/hooks/src/events/*.rs`、`codex-rs/core/src/hook_runtime.rs`：hook 有 preview/run 两阶段、matcher、事件输入输出、阻断/继续/改写工具输入和异步结果；覆盖 session、prompt、tool、permission、compact、interrupt、stop、end 等生命周期。
- `codex-rs/rollout/src/recorder.rs`、`state_db.rs`、`session_index.rs`、`codex-rs/core/src/session/rollout_reconstruction.rs`：rollout 采用追加记录、单写者/顺序 ordinal、索引和 reverse replay；压缩、回滚、fork 后仍能重建有效历史。
- `codex-rs/core/src/config/`：配置层、requirements、权限 profile、approval policy、sandbox/network policy 分开建模；严格 schema 校验未知字段和管理层约束。

### 1.2 Claude Code：可验证范围

Claude Code 核心 CLI/runtime 源码没有在公开仓库发布，本机 `C:\\Users\\LENOVO\\.claude` 只有配置、session-env、plans、file-history 和运行状态，不能证明其内部类名或具体实现。以下能力只作为公开产品契约和设计目标：

- `CLAUDE.md` 分层指令加载；
- tools / permissions / hooks / skills / subagents；
- 交互式确认、plan/compact、会话恢复和文件历史；
- 精确编辑、终端执行、后台任务和大输出处理。

因此，本文把 Codex 源码作为可复现的控制流依据，把 Claude Code 作为兼容性目标，不声称“Claude Code 内部一定有某个未公开类”。

## 2. v2 立项时的仓库审计（历史基线）

### 2.1 已存在但需要重构的模块

```text
src/index.ts                         # CLI 组装和 console 输出
src/types.ts                         # Message/Task/AgentContext 等扁平类型
src/core/agent.ts                    # 旧单层 Agent 循环
src/core/agent-session.ts            # 新外层循环，但仍复用旧语义
src/core/turn.ts                     # 一次模型输出 + 一次工具调用
src/core/executor.ts                 # 直接查 registry 并执行
src/core/streaming-executor.ts       # 读写锁意图，尚未接入流式 tool call
src/core/prompt-builder.ts            # system prompt + 粗略历史截断
src/core/context/*                   # 结果落盘、粗略估算、四级压缩雏形
src/core/task-*.ts                   # 栈式任务和可选 LLM 拆分
src/core/file-state-cache.ts         # mtime/read-before-edit
src/config/*                         # .env、简化 TOML、AGENTS/CLAUDE 发现
src/security/dangerous-paths.ts      # 敏感路径拒绝
src/tools/*                          # shell、文件、搜索、精确编辑
src/model/model-client.ts             # OpenAI 兼容 chat/stream/FakeModel
```

### 2.2 必须修正的结构性问题

1. `Message` 只能表达字符串，无法表达 tool call id、并行调用、响应 item、压缩 checkpoint、图片/自定义输入和中断事件。
2. `AgentSession` 与 `Agent` 并存，两个主循环容易产生行为漂移；应删除旧 `Agent`，只保留一个 `SessionCoordinator`。
3. `runStep` 每次只推进一个模型响应和最多一个工具调用；M2 已接入结构化模型事件，但 `StreamingToolExecutor` 仍未被消费。
4. `Executor` 绕过 approval、hook、sandbox、工具参数 schema 和结果 spill；工具自身承担了太多安全责任。
5. `CompactionPipeline` 返回新数组，但没有将压缩作为 transcript event 持久化，resume 后无法保持同样语义。
6. `FileStateCache` 只检查 mtime/size，不能检测 inode 替换、符号链接、外部写入竞态，也无法给 patch 提供基线 hash。
7. `search.ts` 的 glob/regex、目录遍历和错误处理过于宽松；搜索结果没有稳定的截断/落盘契约。
8. 配置层只有 builtin/user/project/local，缺少 system/managed/session/CLI 的优先级和严格未知字段校验。
9. 任务调度没有依赖图、持久化、取消、失败重试或子 agent 归属。
10. 没有 transcript、resume、fork、记忆数据库、MCP、skills、hooks 和可观测性闭环。

## 3. v2 模块边界

目标目录：

```text
src/
├── app/
│   ├── cli.ts                       # CLI 参数、stdio、退出码
│   ├── exec.ts                      # 非交互 exec 前端
│   └── app-server.ts                # JSON-RPC 前端（后续）
├── protocol/
│   ├── ids.ts                       # branded SessionId/TurnId/CallId
│   ├── items.ts                     # ResponseItem / ToolCall / ToolOutput
│   ├── events.ts                    # 对外事件和内部事件
│   ├── schemas.ts                   # JSON schema 校验与版本
│   └── errors.ts                    # 可恢复/不可恢复错误
├── session/
│   ├── coordinator.ts               # session 生命周期，唯一入口
│   ├── session-state.ts             # immutable snapshot + mutable runtime
│   ├── input-queue.ts               # 用户输入、steer、interrupt、approval
│   ├── turn-runner.ts               # turn 状态机
│   ├── turn-context.ts              # 每次 sampling 的一致视图
│   ├── cancellation.ts              # AbortSignal 树
│   └── fork.ts                      # fork/resume/child session
├── model/
│   ├── client.ts                    # provider-neutral 接口
│   ├── openai-responses.ts         # Responses API
│   ├── openai-chat.ts              # Chat Completions 兼容层
│   ├── retry.ts                    # request retry/fallback
│   └── fake.ts                     # 测试模型
├── context/
│   ├── transcript.ts                # annotated append-only history
│   ├── context-manager.ts           # forPrompt 投影
│   ├── token-budget.ts              # usage anchor + estimate
│   ├── compaction.ts                # pre/mid/manual compact
│   ├── result-store.ts              # 大结果 spill + preview
│   └── world-state.ts               # cwd、roots、permissions、skills snapshot
├── tools/
│   ├── registry.ts                  # runtime 注册和冲突检测
│   ├── router.ts                    # response item -> call -> runtime
│   ├── spec-plan.ts                 # model-visible exposure plan
│   ├── executor.ts                  # admission -> hook -> approval -> runtime
│   ├── parallel.ts                  # read/write gate + ordered collection
│   ├── lifecycle.ts                 # start/finish/abort
│   ├── builtins/                    # exec/read/write/edit/search/task 等
│   ├── mcp/                         # stdio/http/sse/websocket MCP
│   └── extensions/                  # dynamic tools / plugins
├── security/
│   ├── policy.ts                    # approval policy + permission profiles
│   ├── path-policy.ts               # canonical path / symlink / sensitive paths
│   ├── command-policy.ts            # shell tokenization + static checks
│   ├── sandbox/                     # windows / linux / mac adapters
│   └── approval.ts                  # user confirmation broker
├── config/
│   ├── loader.ts                    # layered config + strict validation
│   ├── schema.ts                    # typed schema
│   ├── agents-md.ts                 # AGENTS/CLAUDE provenance and budget
│   ├── skills.ts                    # SKILL.md discovery/frontmatter
│   └── managed.ts                   # system/enterprise requirements
├── tasks/
│   ├── graph.ts                     # task state machine and dependencies
│   ├── planner.ts                   # deterministic + LLM planner
│   ├── scheduler.ts                 # fair ready queue
│   └── persistence.ts               # task events
├── memory/
│   ├── store.ts                     # SQLite source of truth
│   ├── extractor.ts                 # async extraction
│   ├── consolidator.ts              # deduplicate/merge
│   └── retrieval.ts                 # lexical/embedding retrieval
├── persistence/
│   ├── rollout-writer.ts            # single writer JSONL
│   ├── rollout-reader.ts            # streaming/reverse reader
│   ├── session-index.ts             # SQLite index
│   ├── reconstruction.ts            # resume/fork/replay
│   └── trace-writer.ts              # inference/tool trace
├── hooks/
│   ├── registry.ts                  # matcher + trust
│   ├── dispatcher.ts                # preview/run
│   ├── handlers.ts                  # command/prompt/agent/http/callback
│   └── events.ts                    # lifecycle event payloads
└── observability/
    ├── metrics.ts                   # tokens/cost/latency/errors
    ├── logger.ts                    # structured logs
    └── spans.ts                     # session/turn/tool correlation
```

## 4. 核心协议重设计

### 4.1 不再使用扁平字符串 Message

```ts
type SessionId = string & { readonly __brand: "SessionId" };
type TurnId = string & { readonly __brand: "TurnId" };
type StepId = string & { readonly __brand: "StepId" };
type CallId = string & { readonly __brand: "CallId" };

type ResponseItem =
  | { kind: "user_text"; id: string; text: string; turnId: TurnId }
  | { kind: "assistant_text"; id: string; text: string; turnId: TurnId; usage?: Usage }
  | { kind: "assistant_reasoning"; id: string; text: string; turnId: TurnId }
  | { kind: "tool_call"; id: CallId; name: string; namespace?: string; input: unknown }
  | { kind: "tool_result"; id: string; callId: CallId; name: string; output: ToolOutput }
  | { kind: "compact_checkpoint"; id: string; window: CompactWindow; summary: string }
  | { kind: "context_injection"; id: string; source: string; text: string }
  | { kind: "turn_aborted"; id: string; reason: string };

interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
}

interface ToolOutput {
  status: "ok" | "error" | "aborted";
  text: string;
  truncated: boolean;
  persistedPath?: string;
  metadata?: Record<string, unknown>;
}
```

模型适配器返回事件而不是已拼接字符串：

```ts
type ModelEvent =
  | { type: "response_started"; requestId: string }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_started"; callId: CallId; name: string }
  | { type: "tool_call_delta"; callId: CallId; jsonDelta: string }
  | { type: "tool_call_completed"; callId: CallId; input: unknown }
  | { type: "usage"; usage: Usage }
  | { type: "response_completed"; finishReason: string };

interface ModelTransport {
  stream(input: ModelInput, signal: AbortSignal): AsyncIterable<ModelEvent>;
  capabilities(): ModelCapabilities;
}
```

`chat()` 只作为兼容适配器保留，核心循环只依赖 `stream()`。

### 4.2 Session 与 Turn 状态机

```text
Session: created -> ready -> running -> waiting_input -> closing -> closed
Turn:    created -> precompact -> sampling -> dispatching_tools
         -> awaiting_followup -> compacting -> completed|aborted|failed
```

`SessionCoordinator` 负责：

- 分配 session/turn id，恢复 rollout，加载配置和初始 world state；
- 保证最多一个 active turn；
- 将 `UserInput`、`Interrupt`、`ApprovalResponse`、`Compact`、`Shutdown` 放入 `InputQueue`；
- 维护累计 token/cost/elapsed/step budget；
- 在 turn 结束时触发 Stop/SessionEnd hooks、flush transcript 并返回结果。

`TurnRunner` 负责：

1. 读取当前 history/world state，执行 pre-turn compact；
2. 生成一次 `TurnContext`，保证本次请求的工具 spec、权限、cwd 和 skills 一致；
3. 消费模型流；完整 tool call 到达后立即交给 `ToolExecutor`；
4. 按 call id 顺序写入 tool result，判断是否 `needsFollowUp`；
5. 处理 pending input、stop hook、token limit 和 mid-turn compact；
6. 只有模型没有待执行动作且 stop policy 允许时才结束 turn。

建议的可恢复 continue reason：

```ts
type ContinueReason =
  | "tool_result"
  | "pending_user_input"
  | "parse_retry"
  | "transport_retry"
  | "transport_fallback"
  | "context_compacted"
  | "stop_hook_continue"
  | "max_output_tokens_upgrade"
  | "recoverable_tool_error";
```

每个 continue site 都必须记录 `reason`、`turnId`、`attempt` 和 `historyOrdinal`，便于恢复和诊断。

### 4.3 流式工具预执行与并发

`ToolExecutor` 建议拆成四步：

```text
admit -> pre-hook/approval -> concurrency gate -> runtime -> post-hook/result normalize
```

- `ToolRegistry` 元数据包含 `supportsParallel`、`mutatesWorkspace`、`requiresApproval`、`exposure` 和 `namespace`。
- 同一 turn 中 `supportsParallel=true` 的只读工具共享读锁；写工具和未知工具拿写锁。
- 结果按模型提交顺序通过 `Map<CallId, Promise<ToolOutput>>` 收集，不能按完成先后改变 transcript 顺序。
- 每个 call 使用独立 `AbortController`，父 turn 取消会级联；已到达 terminal outcome 的工具不再被重复取消。
- 同一路径的写操作增加 path-level mutex，避免两个写工具同时修改同一个文件。

## 5. 工具平面

### 5.1 Spec 与 Runtime 分离

```ts
interface ToolSpec {
  name: string;
  namespace?: string;
  description: string;
  inputSchema: JsonSchema;
  exposure: "direct" | "deferred" | "code_mode" | "hidden";
  supportsParallel: boolean;
}

interface ToolRuntime<I = unknown> {
  name: string;
  spec(): ToolSpec;
  validate(input: unknown): I;
  execute(ctx: ToolExecutionContext, input: I): Promise<ToolOutput>;
}
```

`SpecPlan` 每次 turn 生成模型可见 spec：先合并内置工具、MCP、dynamic tools、extension tools，再做 namespace 冲突检测、权限过滤、deferred tool search 和 schema sanitize/prune/compact。模型不可见的 runtime 仍可以被 hook 或内部控制流调用，但不能绕过安全检查。

### 5.2 内置工具完整清单

P0：

- `run_command`、`read_terminal_output`：持久 shell、超时、取消、后台任务、stdout/stderr 分离；
- `read_file`、`list_dir`、`search_files`、`search_content`：路径 canonicalize、二进制识别、稳定截断、结果 spill；
- `write_file`、`edit_file`、`apply_patch`：read-before-edit、基线 hash、原子写入、回滚 delta；
- `request_approval`、`request_user_input`：与前端 broker 对接；
- `task_create/get/list/update`：任务图持久化。

P1：

- `spawn_agent`、`send_message`、`wait_agent`、`close_agent`、`resume_agent`；
- `compact`、`get_context_remaining`、`plan`；
- `mcp_list_resources`、`mcp_read_resource`、MCP tool search；
- `view_image`（可选图像输入适配器）；
- `current_time`、`sleep`、`dynamic_tool`。

### 5.3 编辑工具协议

同时支持两种模型接口：

1. Claude 风格 `edit_file(path, old_string, new_string, replace_all?)`：old string 默认必须唯一，写前读取且 hash 未变。
2. Codex 风格 `apply_patch(patch)`：采用 freeform patch grammar，先 parse 成 `FileChange[]`，再做路径/符号链接/权限/安全评估，最后在 sandbox 中提交。

验证流水线：

```text
parse -> normalize line endings -> resolve paths -> read/hash check
     -> detect symlink/danger -> assess safety -> approval
     -> apply atomically -> verify expected delta -> record rollback snapshot
```

失败时返回结构化的 `reason`、文件、hunk、建议动作，不返回模糊的“写入失败”。

## 6. 上下文与压缩

M6 的完整 Codex 源码对齐、当前差距、协议模型、恢复算法和测试矩阵见 [m6-context-checkpoint-compaction.md](./m6-context-checkpoint-compaction.md)。本节只保留总览；若与专项设计冲突，以专项设计为准。

### 6.1 Canonical history

`TranscriptStore` 追加 `ResponseItem`，每项有 ordinal、turnId、parent/fork lineage、createdAt 和 optional usage。 `ContextManager.forPrompt()` 只生成模型输入投影，不删除真历史。

### 6.2 渐进式 context preparation 与 checkpoint compaction

以下有界处理用于减少 compact 输入和模型上下文，不代表前四步可以取代 checkpoint：

1. **Tool result spill**：单结果超过 50,000 字符落到 session result store，模型只看 preview + 路径 + hash。
2. **Tool result clear**：保留最近 N 个工具结果，旧结果替换为可重取引用。
3. **History projection**：把旧 assistant/tool turn 折叠为带 turn/文件/测试信息的摘要。
4. **Local/remote compaction**：按 provider capability 选择专用模型 handoff summary、remote compaction 或 new-context backend，产出经过校验的 replacement history。
5. **Context window rollover**：安装并持久化同一份 replacement history，推进 `window_number` 和 `first/previous/current window id`，随后持久化 full world-state baseline 与 reference turn context。

压缩支持 pre-turn、mid-turn token limit 和显式 manual compact。pre-turn/manual 成功后清除旧 reference context并在下一普通turn全量重注入；mid-turn必须把当前canonical initial context放在最后真实用户消息之前，保证summary/compaction item仍是末项。每次压缩都执行可阻断的生命周期、写入完整replacement history和window lineage；Resume/Fork/rollback从最新surviving checkpoint重放，绝不再次摘要。

### 6.3 Token budget

- 优先使用 provider 返回的 usage 作为锚点；锚点后新增 item 使用可配置估算器。
- 分开 `contextWindowLimit`、`autoCompactLimit`、`maxOutputTokens`、`rolloutBudget` 和 `toolResultBudget`。
- 预算计算必须包括 system/developer instructions、tool schema、skills、MCP spec、图片 token 和 pending input。
- 记录预估值和服务端值的误差；连续超估时降低安全余量，不能静默发送超限请求。
- token status 同时维护模型 hard context limit、auto-compact limit、`total|body_after_prefix` scope、当前窗口 prefill 和有界 fallback buffer；压缩后旧 usage anchor 必须失效并重算。

## 7. 安全与权限

### 7.1 策略层

```ts
type ApprovalPolicy = "never" | "on-request" | "unless-trusted" | "granular";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type Decision = "allow" | "ask" | "deny";

interface PermissionProfile {
  sandbox: SandboxMode;
  approval: ApprovalPolicy;
  writableRoots: string[];
  readableRoots: string[];
  network: "deny" | "proxy" | "allow";
  rules: PermissionRule[];
}
```

安全决策顺序：workspace trust -> managed requirements -> profile -> allow/deny/ask rules -> command/path static analysis -> sandbox capability -> hook -> user confirmation -> runtime。

### 7.2 路径和命令

- 所有路径先 `realpath`/canonicalize，再检查 workspace roots；拒绝 `..` 越界、NTFS alternate data stream、危险设备文件和未经允许的 symlink 穿透。
- 保留 `dangerous-paths.ts`，但改为配置化规则并加入 bypass-immune 路径（凭据、系统目录、`.git` 元数据等）。
- shell 先 tokenize/解析命令链，再识别重定向、管道、后台、网络下载、权限提升、删除/格式化、脚本解释器和动态命令拼接；不能只用正则黑名单。
- Windows 使用受限子进程、Job Object/WFP 能力时通过 adapter 注入；不支持的沙箱必须明确降级并要求 approval。

### 7.3 取消和审计

每次 deny/ask/allow、sandbox violation、hook block、用户确认、工具 abort 都写入 rollout audit item；敏感参数在日志中脱敏。

## 8. 配置、指令和扩展

### 8.1 配置层级

高优先级覆盖低优先级，但 managed requirements 可限制而不能被项目覆盖：

```text
packaged defaults
< system/managed requirements
< user (`/.swe-agent/config.toml)
< project (.swe-agent/config.toml)
< local (.env)
< session flags
< CLI overrides
```

每层保留 `source`、文件路径、解析警告和有效值；使用严格 schema，未知字段在 strict 模式报错，非 strict 模式也要告警。 `config.ts` 只负责 env 兼容，真正合并移到 `config/loader.ts`。

### 8.2 AGENTS.md / CLAUDE.md

- 从 project root 到 cwd 收集层级文件，默认候选 `AGENTS.md`、`CLAUDE.md`，允许配置 fallback filenames。
- 每个 entry 保留来源路径、环境/cwd 和优先级；同一文件不重复注入。
- 字节预算按层递减，截断必须在 UTF-8 字节边界安全完成；模型上下文显示来源。
- system/developer instructions、用户指令和项目指令分段注入，项目文件不能伪造更高优先级的系统规则。

### 8.3 Skills / Plugins / MCP

- `SKILL.md` frontmatter 严格解析，正文按预算分层退化：完整 -> 字符轮转 -> 最小行；只在被提及/匹配时注入。
- plugin manifest 必须声明版本、工具、skills、权限和 hash；安装/启用前需信任检查。
- MCP 连接采用状态机 `disconnected -> connecting -> ready -> degraded -> closed`，支持 stdio、HTTP/SSE 和 websocket adapter；工具 spec 进入 exposure plan，连接失败不能拖死主 session。

## 9. 任务图、多 agent 与协作

### 9.1 任务状态机

```text
pending -> in_progress -> completed
                    \\-> failed -> retrying -> in_progress
pending -> blocked (blockedBy 未完成)
任何 active 状态 -> cancelled
```

`Task` 增加 `parentId`、`ownerSessionId`、`blocks`、`blockedBy`、`attempts`、`budget`、`created/updated` 和验收条件。任务事件写入 transcript，scheduler 只从 ready graph 取任务，不再使用栈。

### 9.2 子 agent

- `spawn` 默认 fork 父 session 的 prompt 前缀和只读配置，但拥有新的 session/turn/transcript。
- 子 agent 可选择 `sync`、`async`、`reviewer`、`worktree` 四种模式；子 agent 的 token、工具调用和文件 delta 归属于 parent task。
- worktree/临时目录隔离由 `WorkspaceProvider` 提供；合并前必须做 diff、冲突和测试检查。
- agent 间通信通过持久化 mailbox，支持 send/follow-up/wait/interrupt；父 agent 不能直接修改子 agent 内存。

## 10. 持久化、resume、fork 和记忆

### 10.1 Rollout 三层与里程碑边界

1. **L1 JSONL**：单写者 append-only，记录 session meta、turn、response item、tool result、approval、compact、task、hook 和 audit event；这是唯一真源。
2. **L2 SQLite**：session index、任务索引、文件变更、记忆和搜索索引；可删除并重建。
3. **L3 trace**：模型请求/响应、tool timing、token/cost、span，敏感内容按 policy 脱敏。

里程碑分工如下：

- **M5 规划 L1 的最小闭环**：session 级 canonical Transcript、单进程单 writer、版本化 envelope、顺序 ordinal、flush/shutdown、尾部修复、reconstruction、Resume、copied Fork 和可重建 JSON index。
- **M5 只注册未来事件类型**：`compact`、`task`、`hook`、`trace` 等 kind 可以进入 schema，但生产逻辑分别由 M6-M10 接入。
- **M6-M9 扩展 L1/L2**：持久化 context checkpoint、任务图、hooks/MCP、queue/mailbox，以及更丰富的 lineage 和 metadata 投影。
- **M10 再引入 L2/L3 优化**：SQLite 查询索引、trace/metrics、归档与检索优化；它们不得反过来成为 M5 Resume 的依赖。

写入要求：原子 append、顺序 ordinal、fsync 策略、崩溃后尾部修复、版本化 schema 和迁移测试。durable item 必须与 transient UI/model delta 分离；M5 只保证单进程 writer，跨进程锁和 reservation 留到后续阶段。

### 10.2 Resume/reconstruction

M5 的 `reconstruction.ts` 设计先处理 session meta、turn 生命周期、user/assistant/tool item、approval 状态和未完成工具；从最新有效事件重建可继续的 session，并对未确认副作用标记 `unknown_outcome`，禁止自动 replay。M5 的 fork 规划采用 copied history + parent boundary。现有原型不能替代完整里程碑验收。

后续阶段再加入 checkpoint window、rollback、reference/paginated fork、active task graph、world-state fingerprint 和历史替换。恢复后必须重新计算 context projection，并向模型重注入当前有效 instructions；不能直接把旧 prompt 当作真相。

### 10.3 Codex 存储能力的延期清单

以下能力属于 Codex 存储系统，但不属于 M5 的交付物；对应里程碑只是规划，不代表已经实现：

| 能力 | 计划阶段 | 延期原因/前置条件 |
|---|---|---|
| reference/paginated fork、`history_base`、byte/ordinal offset | M8-M10 | 需要稳定 lineage、分页读取和 materialization 策略；M5 先用 copied fork |
| SQLite session/task/file projection | M10 | JSONL 规模和查询模式明确后再优化；必须可删除并重建 |
| archive/unarchive/delete/revert 与源 rollout 保护 | M9-M10 | 需要引用计数、归档策略和 destructive action 审计 |
| 跨进程 writer lock、lifecycle reservation、stale writer 清理 | M8-M10 | M5 只保证单进程单 writer，先验证顺序与崩溃语义 |
| queue、approval/input mailbox 的持久化 | M8-M9 | 依赖任务图、hooks/MCP 和多 agent 生命周期 |
| rollout 压缩、materialization、reverse scanner、schema migration | M6-M10 | 需要 checkpoint 格式、迁移版本和大历史性能基线 |
| L3 trace、token/cost/span 与敏感数据 policy | M10 | 与可观测性和 provider 指标一起设计，避免重复事件模型 |
| stale index repair、lineage repair、引用保护 | M9-M10 | 依赖完整 index/projection 和 fork 引用语义 |

这份清单是设计约束：后续实现可以扩展 M5 的 schema 和 store API，但不能绕过 JSONL 真源，或把派生索引当成唯一历史。

### 10.4 记忆

- 分类：`user`、`feedback`、`project`、`reference`；feedback 记录 Why + How to apply。
- Phase 1 异步抽取候选，Phase 2 合并去重并写 SQLite；`MEMORY.md`/summary 是派生索引。
- 默认只在明确相关时召回，支持 lexical baseline，未来可接 embedding；记忆写入有来源、置信度、更新时间和删除接口。

## 11. Hooks 与可观测性

### 11.1 Hooks

统一 payload：session id、turn id、call id、tool name、tool input、tool output、cwd、permission mode、transcript path、subagent metadata。

事件至少包括：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`Stop`、`Interrupt`、`SubagentStart`、`SubagentStop`、`SessionEnd`。

handler 类型：command、prompt、agent、HTTP、in-process callback。每个 hook 有 matcher、timeout、trust hash、failure policy（continue/abort），支持 preview 与 run 分离。PreToolUse 可以 block 或 rewrite input；PostToolUse 可以追加 model-visible context，但不能伪造执行成功。

### 11.2 Metrics

所有日志和事件都关联 `sessionId`、`turnId`、`stepId`、`callId`、`promptId`：

- provider latency、TTFT、stream duration、retry/fallback；
- input/output/cached tokens、compaction 前后 token、预算剩余；
- 工具等待/执行/排队时长、并发度、成功率、超时/取消；
- approval、deny、sandbox violation、hook 结果；
- task/agent 数量、成本和最终完成率。

## 12. 现有文件到 v2 的迁移映射

| 当前文件 | v2 处理 |
|---|---|
| `src/types.ts` | 拆为 `protocol/*`，保留兼容 type alias 一个版本周期 |
| `src/core/agent.ts` | 删除，逻辑迁移到 `session/coordinator.ts` + `turn-runner.ts` |
| `src/core/agent-session.ts` | 重写为唯一 `SessionCoordinator` |
| `src/core/turn.ts` | 重写为采样状态机，消费完整 ModelEvent/tool call |
| `src/core/executor.ts` | 改为 admission/orchestration，不直接执行 runtime |
| `src/core/streaming-executor.ts` | 合并到 `tools/parallel.ts`，用 AbortSignal 和 ordered result |
| `src/core/prompt-builder.ts` | 改为 `ContextManager.forPrompt()`，只负责投影，不负责丢历史 |
| `src/core/context/*` | 迁移到 `context/*`，增加 checkpoint 和 transcript event |
| `src/core/task-*.ts` | 迁移到 `tasks/*`，由 graph + ready queue 替代 stack |
| `src/config/*` | `loader.ts`、`agents-md.ts`、`skills.ts` 分离，保留旧 API wrapper |
| `src/security/dangerous-paths.ts` | 作为 `path-policy` 的一层，不能单独代表安全 |
| `src/tools/registry.ts` | 增加 runtime/spec/exposure/conflict/lifecycle |
| `src/tools/edit.ts` | 保留 edit_file，加入 hash、原子写、rollback |
| `src/tools/file-io.ts` | 拆 builtin tools，统一经过 policy/executor |
| `src/model/model-client.ts` | provider-neutral `ModelTransport` + chat 兼容层 |
| `src/index.ts` | 仅负责 CLI 组装，禁止在入口实现业务循环 |

## 13. 实施顺序与验收

### P0：正确性和安全

1. protocol item/event、唯一 SessionCoordinator、TurnRunner、AbortSignal。
2. M5 transcript JSONL + reconstruction、Resume、copied Fork 最小闭环。
3. ToolRouter/Registry/Executor 三层，schema 校验、read/write gate。
4. `edit_file` hash 校验、`apply_patch` parse/verify/atomic apply。
5. permission profile、approval broker、canonical path、shell static checks。
6. pre/mid-turn compact 与 usage anchor。

验收：模型多次 tool call、并行只读 + 串行写、工具超时/取消、进程崩溃恢复、越界/危险命令拒绝、压缩后继续执行都通过集成测试。

### P1：完整工作流

1. AGENTS/CLAUDE 分层 provenance、skills、hooks preview/run。
2. 任务图、依赖、重试、持久化；子 agent mailbox 和 fork。
3. MCP client、dynamic tool、deferred exposure/tool search。
4. SQLite session index、reference/paginated fork、trace 和结构化 metrics。

验收：可从任意 rollout resume；hook 能 block/rewrite/continue；子 agent 结果和文件 delta 可审计；MCP 断线只影响对应工具。

### P2：体验和扩展

1. worktree provider、远程环境 adapter、Windows sandbox adapter。
2. 记忆抽取/合并/召回、成本预算、模型 fallback。
3. JSON-RPC app-server、交互式 `/compact`、`/clear`、`/resume`、`/plan`。
4. schema 降级、插件签名/信任、可选 embedding 检索。

## 14. 必须建立的测试矩阵

```text
协议：JSON schema、未知 action、并行 call、tool call delta 拼接
会话：单 active turn、steer、interrupt、shutdown、重复 resume
模型：SSE 分片、usage、429/5xx、超时、transport fallback
工具：读并行/写串行、同路径锁、顺序结果、超时、abort
编辑：old_string 不唯一、hash stale、patch hunk、symlink、回滚
上下文：spill、clear、collapse、summary、window rollover、usage anchor
安全：越界、敏感路径、命令链、重定向、网络、sandbox deny、approval
配置：层级覆盖、managed constraint、未知字段、坏 TOML、预算截断
持久化：尾部损坏、ordinal、compact replay、rollback、fork lineage
扩展：hook matcher/trust、MCP 断线、skill budget、动态工具冲突
多 agent：spawn、mailbox、依赖阻塞、取消、worktree 合并
```

每项至少包含单元测试、故障注入测试和一个真实文件系统集成测试；关键 resume/compact/permission 场景增加 snapshot 测试。

## 15. 设计取舍和非目标

- 不在 TypeScript 中复制 Codex 的 Rust 沙箱实现；通过 `SandboxProvider` 接口调用平台能力，能力缺失时采取保守 deny/ask。
- 不把 Claude Code 未公开内部实现写成“事实”；只兼容公开行为和文件格式。
- 不先实现所有 MCP/远程执行细节再验证主循环；P0 必须先让本地单 agent 的 transcript、工具、安全和 resume 形成闭环。
- 不再把“大模型摘要”当作唯一历史；任何摘要都可由 JSONL checkpoint 和原始 item 追溯。
- `FakeModel` 只用于协议/故障测试，不能证明真实 provider 的流式、usage、重试和工具并发行为。

## 16. 交付定义

v2 设计完成的标准不是“目录里有对应文件”，而是以下不变量全部成立：

1. 任意模型输出都经过 typed parser、schema validation、permission admission 和 runtime dispatch。
2. 任意写操作都能回答：谁发起、基于哪个文件版本、经过哪条权限/approval/sandbox 决策、产生了什么 delta。
3. 任意 session 都能从 JSONL 恢复到与崩溃前等价的可继续状态。
4. 任意 compact 都能在不丢失用户目标、约束、任务和最近修改语义的情况下继续 turn。
5. 任意子 agent、hook、MCP 工具和配置来源都能在 transcript/metrics 中追踪。
6. `npm run typecheck` 与 `npm run build` 通过，P0/P1 集成测试在 Windows 和至少一个 Unix CI 环境通过。


