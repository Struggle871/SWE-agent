# Minimal SWE Agent 对齐 Claude Code / Codex 的架构设计文档

> 版本：v0.1 ｜ 日期：2026-08-25 ｜ 开发语言：TypeScript（保持不变）
> 目标：以「网上学习到的 Claude Code 与 OpenAI Codex 源码/架构」为基准，对照当前 `minimal-swe-agent` 项目，梳理尚未实现的能力，并给出可落地的 TypeScript 设计。

---

## 目录

1. [调研结论（源码/架构学习摘要）](#1-调研结论)
2. [当前项目现状分析](#2-当前项目现状分析)
3. [差距分析总表](#3-差距分析总表)
4. [未实现功能设计（核心）](#4-未实现功能设计)
   - 4.1 双层 Agent 循环 + 流式工具预执行
   - 4.2 多级上下文压缩流水线
   - 4.3 Search-and-Replace 编辑工具与 apply_patch
   - 4.4 权限与安全纵深防御
   - 4.5 子 Agent（多 Agent）与上下文隔离
   - 4.6 持久化记忆系统
   - 4.7 Hooks 生命周期
   - 4.8 结构化任务系统
   - 4.9 会话持久化与 Resume
   - 4.10 分层配置与 CLAUDE.md / AGENTS.md
   - 4.11 可观测性
   - 4.12 Sandbox Runtime 构建与资源隔离
   - 4.13 Multi-Agent 通信与协调协议
   - 4.14 安全插件系统与动态加载
   - 4.15 MCP 扩展与配置详解
5. [实施路线图](#5-实施路线图)
6. [参考资料](#6-参考资料)

---

## 1. 调研结论（源码/架构学习摘要）

以下结论均来自对公开资料的研读，非个人臆测。两条主线：

- **Claude Code**：核心 CLI 为闭源，但gei其 npm 发布物（约 51 万行 TypeScript）被社区系统性逆向分析，形成多份架构文档；官方文档公开了 Skills / Subagents / Hooks / MCP / CLAUDE.md 等机制。
- **OpenAI Codex**：`openai/codex` 仓库开源（Apache-2.0），主体为 `codex-rs`（Rust workspace，~120 crate），另有 TypeScript 启动器 `codex-cli` 与 `sdk/typescript`。Rust 部分是理解其 Agent 循环、工具、沙箱、持久化、记忆的首选来源。

### 1.1 Claude Code 关键架构要点

| 模块 | 关键机制（来自逆向分析） |
|---|---|
| 系统主循环 | 双层生成器：`QueryEngine`（会话生命周期，1295 行）包裹 `query()`（单轮循环，1729 行，`async function*`）。7 个 continue site 对应 7 种故障恢复路径；可恢复错误「扣留」不暴露给上层 |
| 流式执行 | `StreamingToolExecutor`（530 行）：模型仍在流式输出时，已解析完成的 tool_use 立即入队执行；`isConcurrencySafe` 判定读写并发（读并行、写串行） |
| 上下文工程 | 5 级渐进压缩：Tool Result 预算裁剪（落盘）→ History Snip → Microcompact（缓存冷/热两条路径）→ Context Collapse（投影折叠）→ Autocompact（fork 子 Agent 摘要，最后手段）。压缩后自动恢复最近编辑的 5 个文件 |
| Token 管理 | 以 API 返回的 `usage` 为「锚点」+ 锚点后新消息粗估（每 token≈4 字节），误差 <5%；按模型维护 max_output_tokens 表；Task Budget 跨压缩结转 |
| 工具系统 | ~55 个工具统一 `buildTool` 工厂 + 三层组装（编译期裁剪→运行时过滤→缓存感知排序）；大结果 >50K 字符落盘只留 2KB 预览；MCP 6 种传输 + 连接状态机 |
| 代码编辑 | `FileEditTool` 用精确 Search-and-Replace（old_string/new_string），唯一性约束 + 多级验证管线 + 尾部空白裁剪（.md/.mdx 例外）；编辑前强制读取 |
| 权限安全 | 7 层纵深防御：工作区信任 → 权限模式（5 种）→ 规则匹配（allow/deny/ask）→ Bash AST（tree-sitter + 23 项静态检查）→ 工具级安全 → 沙箱/Worktree → 用户确认（与 Hook/LLM 分类器竞速） |
| 多 Agent | 子 Agent（4 种执行模式：同步/异步/队友/远程）+ Worktree 隔离 + Fork 子 Agent（继承父前缀以共享 prompt cache） |
| 记忆 | 4 类封闭分类法（user/feedback/project/reference），feedback 必须含 Why + How to apply，project 相对日期转绝对日期；MEMORY.md 是索引；Sonnet 语义召回 + 异步预取；后台记忆提取 |
| Hooks | 27 个事件 × 5 种类型（Command/Prompt/Agent/HTTP/Callback）；退出码是核心通信协议；信任模型基于 hook hash |
| 任务系统 | TaskCreate/TaskGet/TaskList/TaskUpdate 四工具；状态机 pending→in_progress→completed；blocks/blockedBy 双向依赖；「一个任务一个文件」支持多 Agent 并发 |

### 1.2 Codex 关键架构要点

| 模块 | 关键机制（来自 openai/codex 源码走读） |
|---|---|
| 分层 | 分发层（TS CLI）→ 核心（`codex-core` 库）→ 多前端（TUI/Exec/App-Server JSON-RPC/CLI）；沙箱 crate（Seatbelt/Landlock+Bubblewrap/Windows） |
| Agent 循环 | `Session`（最多 1 个 active turn）→ `submission_loop`（Op 分发：UserInput/Interrupt/Approval/Compact/Shutdown）→ `run_turn`（`needs_follow_up` 驱动）→ `run_sampling_request`（请求级韧性）→ `try_run_sampling_request`（事件级状态推进，`FuturesOrdered` 保证按提交顺序消费工具结果） |
| 传输韧性 | WebSocket 优先，失败切 HTTP；`disable_websockets` 是会话级粘性状态；重试 + fallback transport 切换 |
| 上下文 | pre-turn + mid-turn compaction；`run_auto_compact` 作为 token 超限退出保障 |
| 工具系统 | 「模型可见 spec」与「执行 registry」分离：`spec_plan` 先收集→裁剪→暴露；`ToolRouter` 协议适配 + `ToolRegistry` 编排（pre_tool_use→handle→post_tool_use→lifecycle）；Schema 降级 sanitize→prune→compact |
| 编辑工具 | `apply_patch`：freeform patch 语法 + 三层方案（语法约束→语义验证 verify→受控执行 assess_patch_safety）；多级宽松匹配 + 流式状态机解析 |
| 沙箱/权限 | `approval_policy`（untrusted/on-request…）+ `sandbox_mode`（read-only/workspace-write/danger-full-access）；`assess_patch_safety` 三类结果（AutoApprove/AskUser/Reject）；Windows 用 WFP 防火墙 |
| 配置 | `~/.codex/config.toml` 分层加载（user/project/local + MDM requirements）；AGENTS.md 分层发现 + 预算截断；`project_root_markers` 控制父级查找 |
| Skill 注入 | SKILL.md frontmatter 严格解析 + 旁路宽容；预算「分层退化」（全量→字符轮转→最小行）；developer 与 user 双 role 注入 |
| 记忆 | 两阶段管线：Phase1 并行抽取（小模型）→ Phase2 全局合并（consolidation agent）；DB 是 source of truth，MEMORY.md / memory_summary.md 是 derived state；读写分离 |
| 持久化 | 三层：L1 Rollout JSONL（单写者 actor + 延迟材料化）→ L2 SQLite + session_index（跨进程查询索引）→ L3 Rollout Trace；「append-only JSONL 是唯一真源，其它层可重建」 |
| Hooks | 事件 × matcher × handler；preview（只读）与 run 分离；trust 状态机（Managed/Trusted/Untrusted/Modified，基于 hash）；20 份双向 JSON Schema |
| 可观测 | OTel metrics/events/spans；`prompt.id` 关联键；transcript 持久层；成本累加 |

### 1.3 两套体系的对齐结论

对当前项目最有价值的「共同主线」：

1. 主循环要分层：会话生命周期与单轮循环解耦，故障恢复用「continue site」而非 try/catch 包一切。
2. 上下文是核心工程：不是「截断历史」，而是「多级、渐进、可恢复」的压缩 + 精准 token 预算。
3. 编辑工具要抗幻觉：精确字符串替换（Claude Code）或受控 patch（Codex），远优于整文件重写。
4. 安全要纵深：权限模式 + 规则 + AST 命令分析 + 危险路径保护 + 沙箱，缺一不可。
5. 记忆/任务/持久化是「跨会话」能力：会话内 workingMemory 只是起点。
6. 可扩展靠 Hooks 与配置分层：把横切关注点从主循环剥离。

---

## 2. 当前项目现状分析

当前 `minimal-swe-agent` 已具备的骨架：

```
src/
├── index.ts             # 入口：组装 registry / shell / model / ctx
├── config.ts            # .env 读取（单层）
├── types.ts             # Message/Tool/Action/Task/AgentContext 等核心类型
├── core/
│   ├── agent.ts         # 主循环（单层 while + maxSteps）
│   ├── executor.ts      # 工具执行 + withTimeout
│   ├── output-parser.ts # JSON + ReAct 双格式解析、解析失败重试
│   ├── prompt-builder.ts# system prompt 组装 + truncateHistory 截断
│   ├── task-planner.ts  # 可选 LLM 拆分（默认单任务）
│   └── task-scheduler.ts# 栈式调度
├── model/model-client.ts# OpenAI 兼容 + FakeModel（指数退避重试）
└── tools/
    ├── registry.ts      # Map 注册
    ├── terminal.ts      # 持久 shell（cmd/bash + marker 协议）
    ├── file-io.ts       # read/write/list + resolveInWorkspace 越界保护
    ├── search.ts        # search_files / search_content
    └── types.ts         # Tool 接口
```

**已具备（对齐基础较好）**：单 Agent 循环、工具注册表、持久 shell 会话、输出解析与解析重试、简单上下文截断、路径越界保护、模型重试。

**结构性差距（决定后续演进方向）**：

1. `agent.ts` 是「单层大循环」，没有会话层/轮询层分离，也没有事件流与 continue site。
2. `prompt-builder.ts` 只有「丢弃最早消息」一种压缩策略，无落盘、无摘要、无精准 token 锚点。
3. 工具只有全量 `write_file`，没有抗幻觉的精确编辑；没有并发控制、没有大结果落盘。
4. 完全没有权限系统（工具直接执行）、没有沙箱、没有危险路径保护。
5. 没有子 Agent / 委派能力；`workingMemory` 只是会话内 KV，无跨会话记忆。
6. 没有 Hooks、没有分层配置、没有 CLAUDE.md/AGENTS.md 注入。
7. `TaskPlanner`/`TaskScheduler` 极简：无依赖、无持久化、无并发、无状态机。
8. 无会话持久化（无法 resume）、无可观测性（仅 console.log）。

---

## 3. 差距分析总表

> 优先级：P0=核心正确性/安全，P1=能力补齐，P2=体验/工程化。✅=已有，❌=未实现。

| # | 能力 | 当前 | Claude Code | Codex | 优先级 |
|---|---|---|---|---|---|
| 1 | 双层循环（会话层 + 轮询层） | ❌ 单层 | ✅ QueryEngine/query | ✅ Session/run_turn | P0 |
| 2 | 流式输出 + 工具预执行 | ❌ 同步等全量 | ✅ StreamingToolExecutor | ✅ FuturesOrdered | P0 |
| 3 | 故障恢复 continue site | ❌ 仅解析重试 | ✅ 7 个 continue site | ✅ retry + fallback | P0 |
| 4 | 多级上下文压缩 | ❌ 丢弃最早 | ✅ 5 级流水线 | ✅ pre/mid-turn compact | P0 |
| 5 | 工具大结果落盘 + 预览 | ❌ 全量进上下文 | ✅ 50K 阈值落盘 | ✅（类似） | P0 |
| 6 | 精准 token 估算（usage 锚点） | ❌ 字符粗估 | ✅ 锚点+增量 | ✅ 服务端 usage | P1 |
| 7 | Search-and-Replace 编辑 | ❌ 仅全量写 | ✅ FileEditTool | ✅ apply_patch | P0 |
| 8 | apply_patch（diff 应用） | ❌ | 间接 | ✅ freeform patch | P1 |
| 9 | 编辑前强制读取 | ❌ | ✅ 强制 | ✅（推荐） | P1 |
| 10 | 工具并发（读并行/写串行） | ❌ 全串行 | ✅ isConcurrencySafe | ✅ FuturesOrdered | P1 |
| 11 | 工具 schema 降级 | ❌ | ✅ | ✅ sanitize→prune→compact | P2 |
| 12 | 权限模式 | ❌ | ✅ 5 模式 | ✅ approval_policy | P0 |
| 13 | 权限规则 allow/deny/ask | ❌ | ✅ | ✅（部分） | P0 |
| 14 | Bash AST + 静态检查 | ❌ | ✅ tree-sitter 23 项 | ✅（命令解析） | P1 |
| 15 | 危险文件/目录保护 | ❌ 仅越界 | ✅ bypass-immune | ✅（沙箱策略） | P0 |
| 16 | 沙箱隔离 | ❌ | ✅ Seatbelt/ns | ✅ Seatbelt/Bwrap/WFP | P1 |
| 17 | 用户确认交互 | ❌ | ✅ 竞速确认 | ✅ AskUser | P1 |
| 18 | 子 Agent / 委派 | ❌ | ✅ 4 种模式 | ✅ multi_agents | P1 |
| 19 | Worktree 隔离 | ❌ | ✅ | ✅ | P2 |
| 20 | 持久化记忆（4 类分类法） | ❌ | ✅ | ✅ 两阶段 | P1 |
| 21 | 记忆语义召回 + 预取 | ❌ | ✅ Sonnet 召回 | ✅ MCP read | P2 |
| 22 | 后台记忆提取 | ❌ | ✅ | ✅ Phase1/2 | P2 |
| 23 | Hooks 生命周期 | ❌ | ✅ 27 事件 | ✅ hook_runtime | P1 |
| 24 | Hook 信任模型（hash） | ❌ | ✅ | ✅ trust 状态机 | P1 |
| 25 | PermissionRequest Hook | ❌ | ✅ | 间接 | P2 |
| 26 | 结构化任务系统 | ❌ 极简 | ✅ TodoV2 | ✅（部分） | P1 |
| 27 | 任务依赖 blocks/blockedBy | ❌ | ✅ | — | P1 |
| 28 | 会话持久化 + Resume | ❌ | ✅ | ✅ 三层 | P1 |
| 29 | 分层配置 + CLAUDE.md/AGENTS.md | ❌ .env 单层 | ✅ CLAUDE.md | ✅ AGENTS.md | P0 |
| 30 | Skill 系统 | ❌ | ✅ | ✅ SKILL.md | P2 |
| 31 | MCP 客户端 | ❌ | ✅ | ✅ rmcp-client | P1 |
| 32 | Plan 模式（两阶段） | ❌ | ✅ | 间接 | P2 |
| 33 | 斜杠命令 /compact /clear | ❌ | ✅ | 部分 | P2 |
| 34 | 可观测性（token/成本/trace） | ❌ console.log | ✅ OTel | ✅ OTel | P1 |
| 35 | 结构化输出 + max_tokens 升级 | ❌ | ✅ | ✅ | P1 |

---

## 4. 未实现功能设计（核心）

> 本节为每项未实现能力给出 TypeScript 设计：目标、对齐来源、类型定义、核心逻辑、文件落点、与现有代码的集成点。设计遵循「渐进式」——优先改动最小、收益最大的部分。
### 4.1 双层 Agent 循环 + 流式工具预执行

**目标**：把 `agent.ts` 的单层大循环拆成「会话生命周期（AgentSession）+ 单轮循环（runTurn）」两层，并引入事件流，让故障恢复有明确的 continue site，同时让模型流式输出期间就能并行执行工具。

**对齐来源**：Claude Code `QueryEngine`/`query()`、`StreamingToolExecutor`；Codex `Session`/`run_turn`/`try_run_sampling_request`。

#### 4.1.1 类型定义

```ts
// src/core/events.ts
export type AgentEvent =
  | { type: "stream_start" }
  | { type: "stream_delta"; delta: string }
  | { type: "assistant_message"; message: Message }
  | { type: "tool_use_started"; toolName: string; callId: string }
  | { type: "tool_use_completed"; toolName: string; result: ToolResult }
  | { type: "compact_boundary" }        // 触发上下文清理
  | { type: "api_error"; error: Error; recoverable: boolean }
  | { type: "final_answer"; answer: string }
  | { type: "max_turns_reached" };

// 单轮循环的继续原因（对应 Claude Code 的 7 个 continue site）
export type ContinueReason =
  | "normal"                    // 正常推进
  | "parse_retry"               // 解析失败重试
  | "max_output_tokens_upgrade" // 输出 token 上限升级后重试
  | "context_compacted"         // 上下文压缩后重试
  | "transport_fallback"        // 传输降级后重试
  | "tool_error_recoverable"    // 工具错误可恢复
  | "auto_compact_failed";      // 压缩失败熔断
```

```ts
// src/core/agent-session.ts
export class AgentSession {
  // 会话生命周期：负责成本/步数预算、恢复策略、结果提取
  async run(userRequest: string): Promise<AgentRunResult> {
    const history: Message[] = [{ role: "user", content: userRequest }];
    let turnCount = 0;

    while (turnCount < this.ctx.config.maxSteps) {
      const turnResult = await runTurn({
        ctx: this.ctx,
        messages: history,
        onEvent: (e) => this.emit(e),
        canUseTool: (t, input) => this.permissions.canUse(t, input), // 见 4.4
      });

      if (turnResult.terminal) {
        return this.buildResult(turnResult, history);
      }
      turnCount += turnResult.steps;
    }
    return { answer: "达到最大步数", steps: turnCount, history, taskTrace: [] };
  }
}
```

#### 4.1.2 流式工具预执行

关键变化：把 `model.chat()` 从「返回完整字符串」升级为「返回可流式迭代的生成器」，在收到完整工具调用块时立即派发执行。

```ts
// src/model/model-client.ts —— 扩展接口（向后兼容）
export interface ModelClient {
  chat(messages: Message[], options?: ChatOptions): Promise<string>;
  // 新增：流式接口
  stream(messages: Message[], options?: ChatOptions): AsyncGenerator<ModelStreamEvent>;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; name: string; arguments: string }  // 已闭合的工具调用
  | { type: "done"; raw: string };
```

```ts
// src/core/streaming-executor.ts —— 对齐 Claude Code StreamingToolExecutor
export class StreamingToolExecutor {
  private queue: Array<{
    id: string; name: string; input: Record<string, unknown>;
    status: "queued" | "executing" | "completed";
    isConcurrencySafe: boolean;
  }> = [];
  private results = new Map<string, ToolResult>();

  constructor(private ctx: AgentContext, private registry: ToolRegistry,
              private executor: Executor) {}

  addTool(name: string, input: Record<string, unknown>): void {
    this.queue.push({
      id: randomUUID(), name, input,
      status: "queued",
      isConcurrencySafe: this.registry.isReadOnly(name), // 读工具并发安全
    });
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    const executing = this.queue.filter((t) => t.status === "executing");
    for (const t of this.queue) {
      if (t.status !== "queued") continue;
      const canRun = executing.length === 0 ||
        (t.isConcurrencySafe && executing.every((e) => e.isConcurrencySafe));
      if (!canRun) continue;
      t.status = "executing";
      this.executor
        .execute({ type: "tool_call", toolName: t.name, toolInput: t.input }, this.ctx)
        .then((r) => { t.status = "completed"; this.results.set(t.id, r); })
        .finally(() => void this.processQueue());
      return; // 每次只启动一个，避免饿死
    }
  }

  async *collect(): AsyncGenerator<ToolResult> {
    while (this.queue.some((t) => t.status !== "completed")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const t of this.queue) yield this.results.get(t.id)!;
  }
}
```

**集成点**：`runTurn` 中把 `StreamingToolExecutor` 接到模型的 `stream()`；`isConcurrencySafe` 由 `ToolRegistry` 通过工具元数据（新增 `isReadOnly` 标记）提供。

---

### 4.2 M6 上下文 checkpoint 与压缩

> 本节原有“四级简化流水线”只描述了 Phase 2 的内存压缩原型，不能作为 M6 实现方案。M6 必须对齐 Codex 的 context-window、replacement-history 和 rollout reconstruction 语义，不接受先交付字符串摘要或截断历史、再延期补齐 checkpoint 的做法。完整源码证据、差距、协议、恢复算法、失败模型和测试矩阵见 [m6-context-checkpoint-compaction.md](./m6-context-checkpoint-compaction.md)；若本早期设计稿与专项设计冲突，以专项设计为准。

**目标**：canonical Transcript 保持 append-only；压缩只替换当前模型可见投影，并把完整 `replacement_history`、窗口 lineage、world-state baseline 和 reference turn context 作为可恢复 checkpoint 持久化。

**对齐来源**：本地 `openai/codex` 源码中的 `session/turn.rs`、`session/context_window.rs`、`compact.rs`、`compact_remote.rs`、`compact_remote_v2.rs`、`compact_token_budget.rs`、`session/rollout_reconstruction.rs` 及 compact 集成测试。

#### 4.2.1 不可裁剪的 M6 语义

1. **统一 history 所有权**：`SessionCoordinator` 持有唯一 `ContextManager`；`TurnRunner` 不得在局部克隆上形成第二份 history 真相。
2. **三类触发完整落地**：pre-turn、mid-turn 和 manual compact 使用同一生命周期与安装协议；mid-turn 压缩后继续同一 turn，不能重复已经执行的工具副作用。
3. **capability 驱动的 backend**：local model summary、remote compact/v2 和 token-budget new-context 统一产出并校验 replacement history。deterministic string join 只能是测试 fixture。
4. **窗口与 context 身份**：从 session 建立起持久化初始 window id；checkpoint 推进 `window_number`，并记录 first/previous/current window id、触发原因、实现方式、模型与 compatibility hash。
5. **可恢复安装**：backend 成功且 replacement 校验通过后，先 durable append checkpoint，再切换 live projection并提交预计算的window lineage；pre-commit失败、中断或checkpoint写入失败不能改变旧history和窗口。该durable-before-live规则是本项目基于M5 writer失败模型增加的强化，不是对上游Codex当前写入顺序的误述。
6. **checkpoint-aware replay**：Resume、Fork 和 rollback 从最新 surviving checkpoint 的 replacement history 开始正向重放后缀，不再次调用 summarizer，也不截断 canonical Transcript。
7. **world state 重注入**：pre-turn/manual 在下一普通 turn 全量重注入；mid-turn 将当前 canonical initial context 放在最后真实用户消息之前。旧 developer/context wrapper 不能从 remote replacement 原样复活。
8. **完整请求预算**：hard context limit、auto-compact limit、max output、tool schema、system/developer instructions、skills、MCP、图片和 pending input 都进入 token status；usage 必须关联 request/history version/window，压缩后重建 prefill/anchor。
9. **结构和上限**：tool/function call 与 output 成对保留或移除；tool result 在进入 canonical history 前完成 session-scoped、content-addressed spill，checkpoint 单 item 和总 payload 都有硬上限。
10. **有界失败处理**：覆盖取消、超时、transient retry、compact-request overflow、无效replacement、checkpoint/baseline write failure、reconstruction failure和no-progress熔断，禁止同一状态无限compact；`PostCompact`停止不得回滚已提交checkpoint。

#### 4.2.2 与后续里程碑的边界

- M7 才实现完整 Skills 和分层 AGENTS 加载，但 M6 的 world-state schema 必须已经容纳这些 section 与 fingerprint。
- M9 才实现通用 Hooks runtime 和 MCP runtime，但 M6 必须提供可阻断的 compaction lifecycle 调用点、durable 结果状态和 MCP resource-origin 扩展字段。
- reference/paginated Fork 可后续优化；M6 的 copied Fork 与 eager replay 必须先保证与 Resume 相同的 checkpoint 投影语义。
- SQLite 和 trace 是派生层，不能成为 checkpoint 恢复依赖。

#### 4.2.3 验收底线

M6 只有在 pre/mid/manual compact、第二次 compact、Resume、Fork、跨 checkpoint replay、backend parity、token accounting、取消/超时/重试/溢出、崩溃与写入失败都具有对应测试后才能标记完成。FakeModel 只证明协议和故障注入；真实 request shape、流式 usage、provider retry 和 remote compact parity 使用 mock HTTP/SSE 验证。
---

### 4.3 Search-and-Replace 编辑工具与 apply_patch

**目标**：新增 `edit_file`（精确字符串替换）替代/补充整文件 `write_file`，大幅降低幻觉与 token 成本。

**对齐来源**：Claude Code `FileEditTool`（唯一性约束 + 验证管线 + 尾部空白裁剪例外）；Codex `apply_patch`（受控 patch，P1 阶段实现）。

#### 4.3.1 edit_file 工具

```ts
// src/tools/edit.ts
export const editFileTool: Tool = {
  name: "edit_file",
  description: "精确替换文件中的唯一字符串片段（old_string -> new_string）",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径" },
      old_string: { type: "string", description: "文件中实际存在的精确字符串" },
      new_string: { type: "string", description: "替换后的字符串" },
      replace_all: { type: "boolean", description: "替换所有出现位置", default: false },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const p = resolveInWorkspace(ctx, String(input.path));
    const oldStr = String(input.old_string);
    const newStr = normalizeNewString(p, String(input.new_string));
    const content = await fs.readFile(p, "utf8");

    const count = occurrences(content, oldStr);
    if (count === 0) {
      return { toolName: "edit_file", isError: true,
        output: "old_string 未在文件中找到（可能已变化），请重新 read_file 获取最新内容。" };
    }
    if (count > 1 && input.replace_all !== true) {
      return { toolName: "edit_file", isError: true,
        output: `old_string 出现 ${count} 次，不唯一；请提供更多上下文使其唯一，或设置 replace_all=true。` };
    }
    const next = input.replace_all === true
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);
    await fs.writeFile(p, next, "utf8");
    return { toolName: "edit_file", output: `已替换 ${p}（1 处）` };
  },
};

// 尾部空白裁剪，.md/.mdx 例外（两空格表示硬换行）
function normalizeNewString(p: string, s: string): string {
  if (/\.(md|mdx)$/i.test(p)) return s;
  return s.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");
}
```

#### 4.3.2 编辑前强制读取约束（P1）

在 `Executor` 中引入「编辑前必须读取」校验：`edit_file`/`write_file` 目标若未出现在 `workingMemory.lastReadFile`（或文件状态缓存），返回提示要求先 `read_file`。对齐 Claude Code 的并发安全设计。

```ts
// src/core/file-state-cache.ts
export class FileStateCache {
  private cache = new Map<string, { mtimeMs: number; content: string }>();
  // read 后记录 mtime；edit 前校验目标已缓存且 mtime 未变
  markRead(p: string, mtimeMs: number): void { /* ... */ }
  isFresh(p: string): boolean { /* ... */ }
}
```

#### 4.3.3 apply_patch 工具（P1）

对齐 Codex：接受 freeform patch 文本（`@@` 或 `*** Begin Patch` 风格），解析成 hunks 后执行，写盘前做安全评估（复用 4.4 的权限决策）。

```ts
// src/tools/apply-patch.ts
export interface Hunk { filePath: string; before: string[]; after: string[]; }
export function parsePatch(patch: string): Hunk[] { /* 流式状态机解析 */ }
export const applyPatchTool: Tool = {
  name: "apply_patch",
  // 解析 -> 映射文件与预期新内容 -> 安全评估(assessPatchSafety) -> 写盘
};
```

---

### 4.4 权限与安全纵深防御

**目标**：从「工具直接执行」升级为多层防御：权限模式 → 规则 → 命令分析 → 危险路径保护 →（可选）沙箱 → 确认。

**对齐来源**：Claude Code 7 层防御、5 种权限模式、tree-sitter AST；Codex `approval_policy` + `sandbox_mode` + `assess_patch_safety`。

#### 4.4.1 类型与决策流程

```ts
// src/security/permissions.ts
export type PermissionMode =
  | "default"           // 无规则命中时询问
  | "acceptEdits"       // 自动批准编辑类
  | "plan"              // 执行前暂停
  | "bypassPermissions" // 全自动（deny 规则仍生效）
  | "dontAsk";          // 无规则命中时拒绝（CI）

export type PermissionDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "ask"; prompt: string };

export class PermissionManager {
  constructor(private config: { mode: PermissionMode; rules: Rule[] }) {}

  canUseTool(toolName: string, input: Record<string, unknown>): PermissionDecision {
    // 1. deny 规则（最高优先级，bypass-immune）
    const deny = this.match("deny", toolName, input);
    if (deny) return { decision: "deny", reason: deny.reason };

    // 2. 危险路径保护（.git/ .bashrc 等，bypass-immune）
    const danger = checkDangerousPath(toolName, input);
    if (danger) return { decision: "ask", prompt: danger };

    // 3. allow 规则
    if (this.match("allow", toolName, input)) return { decision: "allow" };

    // 4. 模式兜底
    switch (this.config.mode) {
      case "bypassPermissions": return { decision: "allow" };
      case "dontAsk": return { decision: "deny", reason: "dontAsk 模式" };
      case "acceptEdits": return isEditTool(toolName) ? { decision: "allow" } : { decision: "ask", prompt: "" };
      case "plan":
      case "default":
      default: return { decision: "ask", prompt: "" };
    }
  }
}

// 规则：工具名 + 参数匹配（如 run_command(npm test:*)）
interface Rule {
  type: "allow" | "deny" | "ask";
  tool: string;      // "run_command" 或 "edit_file"
  pattern?: string;  // 命令/路径通配符
}
```

#### 4.4.2 Bash 命令安全分析（P1）

对齐 Claude Code：用 AST 而非正则拆解命令意图。TS 生态可选 `web-tree-sitter` + `tree-sitter-bash`，或先落地「危险模式 + 破坏性命令」白名单/黑名单作为过渡。

```ts
// src/security/bash-security.ts
// 过渡方案（无需引入 tree-sitter）：
//   1. 拒绝裸 shell 前缀（curl|wget ... | sh / bash）
//   2. 破坏性命令识别（rm -rf /、git reset --hard 等 -> ask）
//   3. 危险路径（超出 workspace、~、/etc、C:\Windows）-> deny/ask
export function analyzeCommand(command: string): BashRisk {
  return {
    isDestructive: /rm\s+-rf\s+\//.test(command) || /\bgit\s+reset\s+--hard\b/.test(command),
    pipesToShell: /\|\s*(ba|z|k)?sh\b/.test(command),
    escapesWorkspace: false, // 结合 cwd 解析后判断
  };
}
```

**集成点**：`Executor.execute()` 在 `tool.execute` 前调用 `permissions.canUseTool`；`terminal.ts` 的 `run_command` 增加 `analyzeCommand` 前置检查；「ask」决策在 CLI 入口实现交互确认（P1），初期可退化为「打印提示 + 拒绝」。

#### 4.4.3 危险文件/目录保护

```ts
// src/security/dangerous-paths.ts
const DANGEROUS_FILES = [".git", ".gitignore", ".bashrc", ".zshrc", ".env",
  ".claude/settings.json", ".codex/config.toml", "package-lock.json"];
export function checkDangerousPath(toolName: string, input: Record<string, unknown>): string | null {
  if (!isEditTool(toolName) && !isWriteTool(toolName)) return null;
  const p = String(input.path ?? "");
  if (DANGEROUS_FILES.some((d) => p.includes(d))) return `拒绝修改敏感路径 ${p}`;
  return null;
}
```
---

### 4.5 子 Agent（多 Agent）与上下文隔离

**目标**：让主 Agent 能委派子任务给独立上下文的子 Agent，返回摘要；支持同步（阻塞等待）与异步（task-notification）两种模式。

**对齐来源**：Claude Code `AgentTool` 四种执行模式；Codex `multi_agents` / `spawn_task`。

#### 4.5.1 设计

```ts
// src/core/subagent.ts
export interface SubagentSpec {
  name: string;              // 如 "explore" | "plan" | "general"
  description: string;       // 何时使用
  tools: string[] | "*";     // 工具过滤
  systemPrompt: string;
  maxTurns?: number;
  mode: "sync" | "async";
}

export class SubagentRunner {
  async run(spec: SubagentSpec, task: string, parent: AgentContext): Promise<SubagentResult> {
    // 子 Agent 拥有独立上下文（全新 history），仅注入 task + systemPrompt
    const subCtx = this.buildIsolatedContext(parent, spec);
    const sub = new Agent(subCtx);           // 复用同一 Agent 循环
    const result = await sub.run(task);
    // 返回摘要而非完整轨迹（节省父上下文）
    return { summary: result.answer, steps: result.steps };
  }
}
```

```ts
// src/tools/task.ts —— 对齐 Claude Code AgentTool / Codex multi_agents
export const spawnSubagentTool: Tool = {
  name: "spawn_subagent",
  description: "委派子任务给独立上下文的子 Agent，返回摘要",
  parameters: {
    type: "object",
    properties: {
      subagent: { type: "string", description: "子 Agent 类型" },
      task: { type: "string", description: "委派的任务描述" },
      mode: { type: "string", enum: ["sync", "async"], default: "sync" },
    },
    required: ["subagent", "task"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const spec = ctx.subagents?.get(String(input.subagent));
    if (!spec) return { toolName: "spawn_subagent", isError: true, output: "未知子 Agent" };
    const result = await ctx.subagentRunner.run(spec, String(input.task), ctx);
    return { toolName: "spawn_subagent", output: result.summary };
  },
};
```

**异步模式（P1）**：对齐 Claude Code `LocalAgentTask`——父 Agent 立即拿到 `agentId`，子 Agent 完成后通过 `<task-notification>` 注入父下一轮对话；超过 120s 自动后台化（`getAutoBackgroundMs`）。

**Worktree 隔离（P2）**：用 `git worktree` 为每个子 Agent 建独立副本，任务结束无变更则清理。实现要点（对齐 Claude Code `worktree.ts`）：slug 校验（≤64 字符、字母数字 + `./-/_`、禁止 `..`）、大目录符号链接、`git diff` 检测后清理。

---

### 4.6 持久化记忆系统

**目标**：从会话内 `workingMemory` 升级为跨会话持久化记忆：4 类封闭分类法 + 文件存储 + 语义召回（P2）+ 后台提取（P2）。

**对齐来源**：Claude Code 4 类记忆 + MEMORY.md 索引 + 后台提取；Codex 两阶段管线（Phase1 抽取 → Phase2 合并）。

#### 4.6.1 存储与分类法

```ts
// src/memory/types.ts
export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;          // 正文
  why?: string;             // feedback 必填：Why
  howToApply?: string;      // feedback 必填：How to apply
  createdAt: string;        // ISO 日期（project 相对日期必须转绝对）
  updatedAt: string;
}
```

存储：`~/.swe-agent/memories/{user|feedback|project|reference}.md`（每类型一文件，初期足够；对齐 Claude Code 的 `MEMORY.md` 作为索引的思想）。

#### 4.6.2 记忆决策流程（写路径）

```ts
// src/memory/memory-manager.ts
const WHAT_NOT_TO_SAVE = [
  "代码模式/架构/文件路径（读代码可得）",
  "Git 历史/改动（git log 是权威）",
  "调试步骤/修复（在 commit 里）",
  "CLAUDE.md/AGENTS.md 已有内容",
  "临时任务状态/当前对话上下文",
];

export class MemoryManager {
  shouldSave(info: string): boolean {
    // 1. 能从代码/git/文档推导？ -> 否
    // 2. 已在 AGENTS.md 中？ -> 否
    // 3. 归类到四种类型之一？ -> 保存
    return true;
  }
  async save(entry: Omit<MemoryEntry, "id" | "createdAt">): Promise<void> { /* 追加写 */ }
  async list(type?: MemoryType): Promise<MemoryEntry[]> { /* 读取解析 */ }
}
```

#### 4.6.3 注入方式

- 会话启动时：把记忆清单（或 MEMORY.md 索引）注入 system prompt 的「记忆」段（对齐 Claude Code 用户上下文注入）。
- P2：语义召回——用轻量模型对记忆做相关性评分（`selectRelevantMemories`），异步预取不阻塞主循环。

#### 4.6.4 后台记忆提取（P2）

对齐 Codex 两阶段：Phase1 在会话结束/空闲时用便宜模型从 rollout 抽取「可沉淀经验」；Phase2 定期（或跨会话）用合并 Agent 去重、去噪、写回 `MEMORY.md`。设计要点：读写分离（提取只写草稿，注入只读索引）、幂等可恢复（job 表 + watermark）。

---

### 4.7 Hooks 生命周期

**目标**：把横切关注点（校验、通知、上下文注入、审批）从主循环剥离为可配置 Hook。

**对齐来源**：Claude Code 27 事件 × 5 类型；Codex `hook_runtime`（preview/run 分离 + trust 状态机）。

#### 4.7.1 事件与类型（落地子集）

```ts
// src/hooks/types.ts
export type HookEvent =
  | "PreToolUse"        // 工具执行前（可阻止/改写）
  | "PostToolUse"       // 工具执行后（可注入上下文）
  | "UserPromptSubmit"  // 用户输入提交时
  | "Notification"      // 通知
  | "Stop"              // 主循环结束
  | "PreCompact";       // 压缩前

export interface Hook {
  event: HookEvent;
  matcher?: string;       // 如 "run_command" 或 "run_command: npm*"
  command: string;        // 要执行的 shell 命令
  timeoutMs?: number;
  trustedHash?: string;   // 信任模型：hash 校验
}

export type HookDecision =
  | { action: "continue" }
  | { action: "block"; reason: string }
  | { action: "rewrite"; updatedInput: Record<string, unknown> }
  | { action: "additionalContext"; context: string };
```

#### 4.7.2 执行引擎

```ts
// src/hooks/hook-runner.ts
export class HookRunner {
  constructor(private hooks: Hook[]) {}

  async runPreToolUse(toolName: string, input: Record<string, unknown>): Promise<HookDecision> {
    const matched = this.hooks.filter(
      (h) => h.event === "PreToolUse" && matchTool(h.matcher, toolName));
    for (const h of matched) {
      const { exitCode, stdout } = await this.execHook(h, JSON.stringify({ toolName, input }));
      // 退出码语义：0=continue，2=block；stdout 可为 JSON 决策
      const decision = parseHookOutput(exitCode, stdout);
      if (decision.action === "block") return decision;
      if (decision.action === "rewrite") input = decision.updatedInput;
    }
    return { action: "continue" };
  }
}
```

**信任模型**：hook 首次注册计算 `sha256(normalizedCommand)`，要求用户确认并持久化 `trustedHash`；内容变更后 hash 不匹配则跳过或重新确认（对齐 Claude Code / Codex trust 状态机）。

**集成点**：`Executor.execute` 调用 `hookRunner.runPreToolUse`；`AgentSession.run` 结束时调用 `Stop`；`PromptBuilder` 在 `PreCompact` 后可注入 `additionalContext`。
---

### 4.8 结构化任务系统

**目标**：替换极简的 `TaskPlanner`/`TaskScheduler`，提供有状态、有依赖、可持久化的任务系统。

**对齐来源**：Claude Code TodoV2（四工具 + 状态机 + blocks/blockedBy + 文件级存储）。

#### 4.8.1 四工具与状态机

```ts
// src/tasks/tools.ts
export const taskCreateTool: Tool = { name: "task_create", /* subject/description/activeForm/metadata */ };
export const taskGetTool: Tool    = { name: "task_get",    /* taskId */ };
export const taskListTool: Tool   = { name: "task_list",   /* 列表摘要，过滤已完成 blocker */ };
export const taskUpdateTool: Tool = { name: "task_update", /* status/owner/addBlockedBy */ };

// 状态机
export type TaskStatus = "pending" | "in_progress" | "completed"; // deleted = 删文件
```

```ts
// src/tasks/task-store.ts —— 一个任务一个文件，支持并发
export class TaskStore {
  constructor(private dir: string) {} // ~/.swe-agent/tasks/{listId}/
  async create(task: TaskInput): Promise<Task> { /* 目录级 .lock 分配 ID，写 {id}.json */ }
  async get(id: string): Promise<Task> { /* 读 {id}.json */ }
  async update(id: string, patch: Partial<Task>): Promise<void> { /* 锁 {id}.json 后写回 */ }
  async block(fromId: string, toId: string): Promise<void> {
    // 双向：from.blocks += toId；to.blockedBy += fromId
  }
}
```

**调度器改造**：`TaskScheduler` 从「栈」改为「可认领队列」——`next()` 只返回 `blockedBy` 为空的 pending 任务；`AgentSession` 每轮把「已完成任务摘要」注入上下文（对齐现有 `CompletedTaskSummary`，但升级为持久化 + 依赖）。

---

### 4.9 会话持久化与 Resume

**目标**：会话事件落盘，支持 `--resume` 与崩溃恢复；trace 可诊断。

> 分期说明：本文件是早期设计稿；M5 的实际边界、Codex 存储能力延期清单和验收契约以 [alignment-design-v2.md](./alignment-design-v2.md) 与 [m5-transcript-resume-fork.md](./m5-transcript-resume-fork.md) 为准。M5 先实现 JSONL canonical transcript、reconstruction、Resume、copied Fork 和可重建轻量索引。

**对齐来源**：Codex 三层持久化（rollout JSONL + SQLite 索引 + trace）。

#### 4.9.1 设计（单进程起步，JSONL 单真源）

```ts
// src/persist/rollout-recorder.ts
// append-only JSONL：首行 SessionMeta，后续每行 { ts, item }
export type RolloutItem =
  | { kind: "session_meta"; conversationId: string; model: string; cwd: string }
  | { kind: "message"; role: Role; content: string; name?: string }
  | { kind: "tool_call"; toolName: string; input: Record<string, unknown> }
  | { kind: "tool_result"; toolName: string; output: string; isError?: boolean }
  | { kind: "compacted"; summary: string }
  | { kind: "turn_context"; taskId?: string; completedTasks: CompletedTaskSummary[] };

export class RolloutRecorder {
  // 单写者：内部 async 队列，保证顺序写
  add(item: RolloutItem): void { this.queue.push(item); }
  async flush(): Promise<void> { /* 批量 append */ }
  async load(path: string): Promise<RolloutItem[]> { /* 反序列化 */ }
}
```

**Resume**：`index.ts` 增加 `--resume <sessionId>`，从 rollout 重建 `history`/`taskTrace`，注入「中断 marker」（对齐 Codex `InterruptedTurnHistoryMarker`），继续 `AgentSession.run`。

**SQLite 索引（后续阶段，当前规划为 M10）**：多会话列表/检索时再引入 `node:sqlite`（Node 22+）做查询索引；JSONL 始终是真源，SQLite 可删除并重建，不是 M5 Resume 的前置依赖。

---

### 4.10 分层配置与 CLAUDE.md / AGENTS.md

**目标**：用分层配置替换单层 `.env`，并支持项目记忆文件注入。

**对齐来源**：Claude Code `CLAUDE.md` 分层发现 + 注入顺序；Codex `config.toml` 分层 + AGENTS.md 分层发现 + 预算截断。

#### 4.10.1 分层加载

```ts
// src/config/layered-config.ts
export interface ConfigLayer {
  source: "builtin" | "user" | "project" | "local";
  values: Partial<AgentConfig>;
}
// 优先级：builtin < user(~/.swe-agent/config.toml) < project(./.swe-agent/config.toml) < local(.env / CLI 覆盖)
export async function loadLayeredConfig(overrides: Partial<AgentConfig>): Promise<AgentConfig> {
  const layers = [
    await loadBuiltin(),
    await loadUserConfig(),     // 用户级
    await loadProjectConfig(),  // 项目级
    { source: "local", values: overrides },
  ];
  return mergeLayers(layers);
}
```

#### 4.10.2 记忆文件发现与注入

```ts
// src/config/agents-md.ts
// 从 cwd 向上逐级查找 CLAUDE.md / AGENTS.md，合并（子目录可继承父目录）
export function discoverAgentMemories(cwd: string): string[] {
  const found: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) found.unshift(p); // 最近层优先
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}
```

**预算截断**：对齐 Codex——记忆文件按总字节预算截断，超出部分输出 warning 而非报错；`project_root_markers`（如 `.git`）可停止父级查找。

**注入顺序**（对齐两套体系、利于缓存）：system prompt（稳定）→ 工具定义 → AGENTS.md/CLAUDE.md 内容 → 记忆 → 当前任务/已完成任务（动态）。

---

### 4.11 可观测性

**目标**：记录 token 使用、成本、步骤轨迹，支持事后诊断。

**对齐来源**：Claude Code OTel + transcript + prompt.id；Codex OTel + rollout trace。

#### 4.11.1 设计

```ts
// src/observability/telemetry.ts
export interface Usage {
  inputTokens: number; outputTokens: number;
  cacheReadTokens?: number; cacheCreationTokens?: number;
}
export interface TraceEvent {
  ts: number;
  promptId: string;          // 一次 prompt 的唯一关联键
  event: "model_call" | "tool_exec" | "compact" | "permission" | "final";
  detail: Record<string, unknown>;
}
export class Telemetry {
  private events: TraceEvent[] = [];
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  record(e: Omit<TraceEvent, "ts" | "promptId">, promptId: string): void { /* 追加 */ }
  getCost(modelPricing: Record<string, number>): number { /* usage * 单价 */ }
  export(format: "json" | "text"): string { /* 输出 */ }
}
```

**集成点**：`model-client` 在每次响应返回 usage；`AgentSession` 每轮生成 `promptId`（`randomUUID`），贯穿工具执行/权限决策；`AgentRunResult` 增加 `usage`/`cost` 字段。


---

### 4.12 Sandbox Runtime 构建与资源隔离

**目标**：给命令执行增加操作系统级隔离，即使模型/代码本身被诱导，也无法越界破坏系统。

**对齐来源**：Claude Code `@anthropic-ai/sandbox-runtime` + `SandboxManager` 适配器（源码 `src/utils/sandbox/sandbox-adapter.ts`，三维度限制 + 路径模式 + `autoAllowBashIfSandboxed` + `dangerouslyDisableSandbox`）；Codex `sandboxing`/`linux-sandbox`/`windows-sandbox-rs`（macOS Seatbelt、Linux Landlock+Bubblewrap、Windows WFP 防火墙），`sandbox_mode` 三值。

#### 4.12.1 沙箱模式枚举（对应 Codex sandbox_mode）

```ts
// src/security/sandbox.ts
export type SandboxMode =
  | "read-only"          // 只读探索：文件系统只读
  | "workspace-write"    // 默认：可写 workspace + 临时目录
  | "danger-full-access"; // 无沙箱（危险，需显式开启）

export interface SandboxConfig {
  mode: SandboxMode;
  writableRoots: string[];       // 可写路径
  readOnlyAlways: string[];      // 始终禁写（settings 等）
  allowedDomains?: string[];     // 网络白名单
  deniedDomains?: string[];      // 网络黑名单
  allowManagedDomainsOnly?: boolean; // 企业锁定
}
```

#### 4.12.2 三维度限制（对齐 Claude Code 沙箱设计）

```ts
// src/security/sandbox-runtime.ts
export class SandboxRuntime {
  constructor(private cfg: SandboxConfig) {}

  // 文件系统：可写范围 = 项目目录 + 临时目录；始终禁写 settings.json 等
  isWritable(p: string): boolean {
    if (this.cfg.readOnlyAlways.some((r) => p.startsWith(r))) return false;
    return this.cfg.writableRoots.some((r) => p === r || p.startsWith(r + path.sep));
  }

  // 网络：从 WebFetch allow 规则提取域名白名单；deny 规则进黑名单
  isNetworkAllowed(host: string): boolean {
    if (this.cfg.allowManagedDomainsOnly) return this.cfg.allowedDomains?.includes(host) ?? false;
    if (this.cfg.deniedDomains?.includes(host)) return false;
    return this.cfg.allowedDomains?.length ? this.cfg.allowedDomains.includes(host) : true;
  }

  // 进程隔离：平台机制（见 4.12.4）
}
```

**路径模式约定**（对齐 Claude Code 沙箱路径语法）：

| 模式 | 含义 | 示例 |
|------|------|------|
| `//path` | 文件系统绝对路径 | `//var/log` → `/var/log` |
| `/path` | 相对设置文件目录 | `/src` → `{settings-dir}/src` |
| `~/path` | 用户主目录 | `~/Downloads` |
| `./path` 或 `path` | 相对路径 | 由运行时处理 |

#### 4.12.3 自动放行与显式逃逸

```ts
// src/security/sandbox-policy.ts
export function canAutoAllow(sandboxed: boolean, autoAllowBashIfSandboxed: boolean,
                             rule: Rule | undefined): boolean {
  // 沙箱化 + autoAllowBashIfSandboxed -> 跳过确认
  if (sandboxed && autoAllowBashIfSandboxed) {
    // 例外：dangerouslyDisableSandbox 不享受；显式 deny/ask 仍生效
    if (rule?.type === "deny" || rule?.type === "ask") return false;
    return true;
  }
  return false;
}

// 命令需系统级访问时，模型必须显式设 dangerouslyDisableSandbox=true，
// 且用户须在对话框批准（对齐 Claude Code 的命名即提醒设计）
export function isDangerouslyDisableSandbox(input: Record<string, unknown>): boolean {
  return input.dangerouslyDisableSandbox === true;
}
```

#### 4.12.4 路径边界保护（对齐 12.10，比现有 resolveInWorkspace 更强）

```ts
// src/security/path-validation.ts
export function checkPathConstraints(candidate: string, roots: string[]): string | null {
  // 1. 主工作目录 + 附加目录（/add-dir）检查
  const abs = path.resolve(candidate);
  const inRoot = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!inRoot) return `路径越界: ${candidate}`;

  // 2. 符号链接对称比较：同时 realpath 路径与工作目录，防止 symlink 逃逸
  const real = fs.realpathSync.native?.(abs) ?? abs;
  const realRoots = roots.map((r) => fs.realpathSync.native?.(r) ?? r);
  const realInRoot = realRoots.some((r) => real === r || real.startsWith(r + path.sep));
  if (!realInRoot) return `符号链接越界: ${candidate} -> ${real}`;
  return null;
}

// 危险删除防护：rm/rmdir 目标为 /、/home、/etc、~ 时强制确认且不提供「始终允许」
export function checkDangerousRemoval(command: string): boolean {
  return /\brm\s+(-[a-z]*\s+)?(-rf\s+)?(\/|~|\/home|\/etc)\b/.test(command);
}
```

**Bash 专用路径提取器**（对齐 Claude Code `PATH_EXTRACTORS`）：为 `cd/mkdir/touch/rm/mv/cp/cat/grep/sed/git` 等命令分别实现路径提取逻辑，例如 `cp` 需同时校验源与目标，`cat` 只校验读取路径。TS 落地为一张 `命令名 → 路径提取函数` 的映射表。

**平台落地策略**：

- P1（本机起步）：进程级过渡——Windows 用受限 token / 低完整性进程；Linux/macOS 初期用 `bubblewrap`/`sandbox-exec` 包装 `run_command`，同时把 4.12.4 的路径边界 + 危险删除防护作为纯本地兜底（无系统依赖）。
- P2（完整对齐）：Landlock+Bubblewrap（Linux）/ Seatbelt（macOS）/ WFP 防火墙（Windows）三平台隔离。

**集成点**：`terminal.ts` 的 `ShellSession.run` 在执行前调用 `SandboxRuntime.isWritable/isNetworkAllowed` 与 `checkPathConstraints`；`runCommandTool.execute` 解析 `dangerouslyDisableSandbox` 与 `timeoutMs` 参数，结合 `PermissionManager` 决策。
---

### 4.13 Multi-Agent 通信与协调协议

**目标**：从「单 Agent 子任务委派」升级为完整的三种多 Agent 协作模式（子 Agent / 协调器 / Swarm），并定义统一的通信协议。

**对齐来源**：Claude Code 协调器模式（`coordinatorMode.ts`）、Swarm（`src/utils/swarm/backends/`，`TeammateExecutor` 统一接口 + mailbox + Scratchpad）、Worker 结果传递（同步 tool_result / 异步 `<task-notification>` + 通知去重 + handoff 安全分类）；Codex `mailbox_delivery_phase` + `SendMessage` 寻址 + `multi_agents`。

#### 4.13.1 三种多 Agent 模式

| 模式 | 定位 | 通信方式 | 何时用 |
|---|---|---|---|
| 子 Agent（委派） | 主 Agent 分派、等摘要返回 | 同步 tool_result / 异步 task-notification | 局部探索、隔离上下文 |
| 协调器（Coordinator） | 纯编排，不直接改文件 | Agent/SendMessage/TaskStop | 大任务并行分解 |
| Swarm（对等） | 命名 Agent 点对点 | mailbox 信箱 | 长期并行协作 |

#### 4.13.2 统一执行器接口（对齐 TeammateExecutor）

```ts
// src/multi-agent/teammate-executor.ts
export interface TeammateExecutor {
  spawn(config: TeammateConfig): Promise<string>;        // 返回 agentId
  sendMessage(agentId: string, message: string): Promise<void>;
  terminate(agentId: string, reason: string): Promise<void>; // 优雅关闭
  kill(agentId: string): Promise<void>;                     // 立即中断
  isActive(agentId: string): boolean;
}

export interface TeammateConfig {
  name: string;
  systemPrompt: string;
  tools: string[] | "*";
  permissionBridge: "leader" | "mailbox";
}
```

#### 4.13.3 协调器模式（对齐 8.3）

核心约束：协调器只能使用 `Agent`/`SendMessage`/`TaskStop`，**不能**使用 Bash/Edit/Read——工具集的硬限制防止它退化成普通单 Agent，强制它只做编排。

```ts
// src/multi-agent/coordinator.ts
export const COORDINATOR_TOOLS = new Set(["spawn_subagent", "send_message", "task_stop"]);
export const INTERNAL_WORKER_TOOLS = new Set(["team_create", "team_delete", "send_message", "synthetic_output"]);

export function buildWorkerTools(mode: "simple" | "full"): string[] {
  if (mode === "simple") return ["run_command", "read_file", "edit_file"];
  return ALL_TOOL_NAMES.filter((n) => !INTERNAL_WORKER_TOOLS.has(n));
}

// 协调器用户上下文：告知 Worker 能力边界、可用 MCP、Scratchpad 路径
export function buildWorkerToolsContext(workers: TeammateConfig[], mcpServers: string[],
                                        scratchpadDir?: string): string {
  return [
    `Workers have tools: ${workers.map((w) => w.tools.join(",")).join("; ")}`,
    mcpServers.length ? `MCP servers: ${mcpServers.join(", ")}` : "",
    scratchpadDir ? `Scratchpad directory: ${scratchpadDir}` : "",
  ].filter(Boolean).join("\n");
}
```

**协调器提示词设计精要**（来自源码 `getCoordinatorSystemPrompt`，可直接复刻）：

1. 「Never write based on your findings」——协调器必须自己综合理解，产出含具体文件路径/行号的指令。
2. 「Every message you send is to the user」——Worker 通知是内部信号，不是对话伙伴。
3. 「Workers can't see your conversation. Every prompt must be self-contained」——Worker prompt 必须自包含。
4. Continue vs Spawn 决策：研究到实施同一文件 → Continue；方法完全错误 → Spawn（避免错误上下文锚定重试）。

#### 4.13.4 信箱通信协议（对齐 Swarm mailbox + Codex mailbox）

```ts
// src/multi-agent/mailbox.ts
export interface Mail {
  from: string; to: string; kind: "message" | "permission_request" | "permission_response";
  payload: string; ts: number;
}
export class Mailbox {
  private boxes = new Map<string, Mail[]>(); // agentId -> 队列
  async write(to: string, mail: Mail): Promise<void> { /* 入队 + 通知 */ }
  async read(agentId: string): Promise<Mail[]> { /* 出队并清空 */ }
}
```

**权限桥接**（对齐 InProcess 后端）：首选 Worker 直接调 Leader 的确认对话框（带 Worker badge）；后备用 mailbox 走 `registerPermissionCallback` + `processMailboxPermissionResponse`。每个 Worker 持有独立 `AbortController`，失败不级联。

#### 4.13.5 Scratchpad：跨 Worker 知识共享（对齐 8.4）

```ts
// src/multi-agent/scratchpad.ts
// 共享目录，Worker 免权限读写，用于持久化研究发现/中间结果，
// 避免「Worker A → 协调器转述 → Worker B」的信息丢失
export class Scratchpad {
  constructor(public dir: string) {} // 注入协调器上下文：Workers can read/write here without permission prompts
  async write(name: string, content: string): Promise<string> { /* 写文件返回路径 */ }
  async read(name: string): Promise<string> { /* 读文件 */ }
}
```

#### 4.13.6 Worker 结果传递（对齐 8.5）

```ts
// 同步路径：父 Agent 阻塞，只取子 Agent 最后一条 assistant 文本，作为 tool_result 嵌入
export interface SyncAgentResult {
  status: "completed"; agentId: string;
  content: string; totalToolUseCount: number; totalDurationMs: number; totalTokens: number;
}

// 异步路径：父 Agent 立即收到「已启动」；完成后以 <task-notification> 注入下一轮
export interface TaskNotification {
  taskId: string; status: "completed" | "failed" | "killed";
  summary: string; result?: string;
  usage: { totalTokens: number; toolUses: number; durationMs: number };
}

export function toTaskNotificationXml(n: TaskNotification): string {
  return [
    "<task-notification>",
    `  <task-id>${n.taskId}</task-id>`,
    `  <status>${n.status}</status>`,
    `  <summary>${n.summary}</summary>`,
    n.result ? `  <result>${n.result}</result>` : "",
    `  <usage><total_tokens>${n.usage.totalTokens}</total_tokens>` +
    `<tool_uses>${n.usage.toolUses}</tool_uses><duration_ms>${n.usage.durationMs}</duration_ms></usage>`,
    "</task-notification>",
  ].filter(Boolean).join("\n");
}
```

**通知去重**：每个异步任务持原子 `notified` 标志；`TaskStop` 已标记则丢弃后续完成通知。**Handoff 安全分类**（对齐 `classifyHandoffIfNeeded`）：子 Agent 结果回传父级前运行安全分类，防止通过文件内容（README 里的 prompt injection）借子 Agent 跳板注入父对话；命中则把安全警告前置到结果文本。
---

### 4.14 安全插件系统与动态加载

**目标**：把 Skills / Hooks / Subagents / MCP 打包为可安装、可动态加载、有信任边界的插件单元。

**对齐来源**：Claude Code plugin（一个插件捆绑 skills + hooks + subagents + MCP）、技能 5 来源优先级 + 懒加载 + 信任层级 + `SAFE_SKILL_PROPERTIES` 白名单 + MCP 技能隔离（源码 `commands.ts`/`loadSkillsDir.ts`/`SkillTool.ts`）；Codex Plugin 市场（`core-plugins`，21K LOC）。

#### 4.14.1 插件清单

```ts
// src/plugin/types.ts
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  // 指向各类资源的相对路径
  skills?: string[];      // SKILL.md 所在目录列表
  hooks?: string[];       // hook 配置 json 列表
  subagents?: string[];   // .agent.md / subagent 定义列表
  mcpServers?: McpServerConfig[]; // MCP 服务端配置
  settings?: Record<string, unknown>; // 默认设置
}
```

#### 4.14.2 来源优先级与加载顺序（对齐 skills 5 来源）

```ts
// src/plugin/loader.ts
// 优先级：bundled > managed > user > project > plugin > mcp（findCommand 返回第一个匹配）
export async function loadAllPlugins(): Promise<LoadedPlugin[]> {
  const sources = [
    { kind: "bundled", dir: builtinDir },       // 内置，最高优先级
    { kind: "managed", dir: enterpriseDir },    // 企业策略
    { kind: "user", dir: "~/.swe-agent/plugins" },
    { kind: "project", dir: "./.swe-agent/plugins" },
    { kind: "plugin", dir: installedPluginDir }, // 第三方
    { kind: "mcp", dir: null },                  // 远程，最低
  ] as const;
  // realpath 去重；同名校验（bundled 不可被覆盖）
  return dedupe(await Promise.all(sources.map(load)));
}
```

#### 4.14.3 懒加载（对齐 Claude Code 设计）

只预加载 frontmatter（name/description/whenToUse），完整提示词内容在调用/触发时才读取：

```ts
// src/plugin/lazy-load.ts
export interface SkillFrontmatter { name: string; description: string; whenToUse?: string; }
export function estimateFrontmatterTokens(s: SkillFrontmatter): number {
  return roughTokenCount([s.name, s.description, s.whenToUse].filter(Boolean).join(" "));
}
// 模型只见「有哪些技能可用」；内容按需读，展示成本低、执行成本按需付
```

#### 4.14.4 信任层级 + 安全属性白名单（对齐 5.6）

```ts
// src/plugin/trust.ts
export type SourceKind = "managed" | "bundled" | "user" | "project" | "plugin" | "mcp";
export const TRUST_LEVEL: Record<SourceKind, number> = {
  managed: 5, bundled: 4, user: 3, project: 3, plugin: 2, mcp: 1,
};

// 白名单（默认拒绝）：新增属性未列入白名单 -> 默认走审批，而非默认放行
export const SAFE_SKILL_PROPERTIES = new Set([
  "name", "description", "whenToUse", "allowedTools", "model", "permissionMode",
]);

export function hasOnlySafeProperties(skill: Record<string, unknown>): boolean {
  return Object.keys(skill).every((k) => SAFE_SKILL_PROPERTIES.has(k));
}

// MCP/远程技能隔离：内联 shell 一律不执行；不替换本地路径变量（防信息泄露）
export function isMCPIsolated(source: SourceKind): boolean {
  return source === "mcp";
}
```

**安全文件提取**（对齐 `safeWriteFile`）：运行时解包资源用 `O_NOFOLLOW | O_EXCL` 防符号链接攻击、拒绝 `..`/绝对路径、`0o700/0o600` owner-only、懒提取 + memoize。

#### 4.14.5 动态加载与热更新

```ts
// src/plugin/manager.ts
export class PluginManager {
  private loaded = new Map<string, LoadedPlugin>();
  async install(pathOrName: string): Promise<void> { /* 解析 manifest -> 校验 -> 注册 skills/hooks/subagents/mcp */ }
  async enable(name: string): Promise<void> { /* 动态注册 */ }
  async disable(name: string): Promise<void> { /* 注销 + 清理 invokedSkill 记录 */ }
  // 热更新：记录插件文件 hash，变更后重载并重新校验信任
  private watchForChanges(name: string): void { /* fs.watch -> 对比 hash -> reload */ }
}
```

**集成点**：`PluginManager` 产出 Skills/Hooks/Subagents/MCP 四类资源，分别注入 4.6（技能/记忆）、4.7（Hooks）、4.13（Subagents）、4.15（MCP）的对应注册表；`loadAllPlugins` 在 `AgentSession` 启动阶段调用。
---

### 4.15 MCP 扩展与配置详解

**目标**：通过 MCP（Model Context Protocol）把外部工具/资源接入工具系统，走与内置工具完全相同的执行流水线。

**对齐来源**：Claude Code MCP 集成（`services/mcp/types.ts`，6 种传输 + 8 种服务端配置 + 连接状态机 + OAuth 2.0/PKCE + 7 种作用域 + 大结果处理）；Codex `codex-mcp`/`rmcp-client`/`mcp-server`（客户端 + 服务端双向集成）。

#### 4.15.1 传输层与服务端配置

```ts
// src/mcp/types.ts
export type McpTransport = "stdio" | "sse" | "http" | "ws" | "sdk";
// Claude Code 实测 6 种传输 + 8 种服务端配置（多 ws-ide / claudeai-proxy）；
// 我们落地 5 种常用传输，配置按 discriminated union 扩展

export type McpServerConfig =
  | { kind: "stdio"; command: string; args?: string[]; env?: Record<string, string> }   // 本地子进程
  | { kind: "http" | "sse" | "ws"; url: string; headers?: Record<string, string> }        // 远程
  | { kind: "sdk"; factory: () => McpServer };                                            // 进程内
```

#### 4.15.2 连接状态机（对齐 Claude Code）

```ts
// src/mcp/connection.ts
export type McpConnectionState =
  | "pending" | "connected" | "failed" | "needs_auth" | "disabled";

export class McpClient {
  state: McpConnectionState = "pending";
  async connect(): Promise<void> {
    // pending -> connected；失败 -> failed；OAuth 需认证 -> needs_auth -> connected
  }
  private detectSessionExpiry(httpStatus: number, jsonRpcError: number): boolean {
    return httpStatus === 404 || jsonRpcError === -32001; // HTTP 404 / JSON-RPC -32001
  }
}
```

#### 4.15.3 桥接工具（对齐 MCPTool / ListMcpResources / ReadMcpResource）

```ts
// src/mcp/bridge.ts
// 把 MCP tools/resources/prompts 桥接为内部 Tool，并入 ToolRegistry
export function bridgeMcpTools(servers: McpClient[]): Tool[] {
  return servers.flatMap((s) => {
    const tools = s.listTools().map((t) => ({
      name: `mcp_${s.name}_${t.name}`,     // namespace 前缀，避免与内置工具冲突
      description: t.description,
      parameters: sanitizeSchema(t.inputSchema),  // 复用 4.2/schema 降级
      isReadOnly: isReadOnlyHint(t),
      execute: (input) => s.callTool(t.name, input),
    }));
    return tools;
  });
}

// 资源桥接：list_mcp_resources / read_mcp_resource（对齐 Claude Code）
export const listMcpResourcesTool: Tool = { name: "mcp_list_resources", /* ... */ };
export const readMcpResourceTool: Tool = { name: "mcp_read_resource", /* ... */ };
```

#### 4.15.4 配置与作用域

```ts
// 作用域（对齐 Claude Code 7 种，落地 3 种核心）
export type McpScope = "local" | "user" | "project";
// 配置示例（~/.swe-agent/config.toml 的 [mcp_servers]）
// [mcp_servers.my-server]  command="node"  args=["my-mcp-server.js"]
// [mcp_servers.remote]    url="https://api.example.com/mcp"
export function mergeMcpConfigs(scopeOrder: McpScope[]): McpServerConfig[] {
  // local 覆盖 project 覆盖 user；同名去重
  return dedupeByName(scopeOrder.flatMap(loadScope));
}
```

#### 4.15.5 大结果处理与合并

```ts
// 对齐 Claude Code：MCP 输出超 25K token 就地截断 + 提示；超大文本走 tool-results 落盘
const MCP_MAX_RESULT_TOKENS = 25_000;
export function truncateMcpOutput(output: string): string {
  if (roughTokenCount(output) <= MCP_MAX_RESULT_TOKENS) return output;
  return output.slice(0, MCP_MAX_RESULT_TOKENS * 4) + "\n...(truncated)";
}
// assembleToolPool 阶段：MCP 工具与内置工具合并、去重后统一注册，
// 与内置工具走同一权限/沙箱/Hook 流水线（对齐 Claude Code「协议而非 SDK」思想）
```

#### 4.15.6 双向集成（对齐 Codex mcp-server，P2）

把本地工具暴露为 MCP 服务端，供外部 Agent 调用：

```ts
// src/mcp/server.ts —— 本地 tool registry -> MCP tools/list + tools/call
export function serveRegistryAsMcp(registry: ToolRegistry): McpServer {
  return {
    listTools: () => registry.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
    callTool: (name, args) => registry.get(name)?.execute(args, ctx) ?? { isError: true },
  };
}
```

**OAuth（P2）**：对齐 Claude Code 三阶段——OAuth 2.0 + PKCE（自动轮换 + 30s 超时）、XAA/OIDC 企业 IdP、Token 主动刷新 + Keychain 缓存。

**集成点**：`index.ts` 在启动时 `mergeMcpConfigs` → `McpClient.connect`（状态机）→ `bridgeMcpTools` → `registry.register`，使 MCP 工具与内置工具统一进入 `PromptBuilder` 的「可用工具」清单与 `PermissionManager` 决策。

---

## 5. 实施路线图

| 阶段 | 内容 | 对应章节 | 验收标准 |
|---|---|---|---|
| Phase 1（地基） | 双层循环 + 事件流 + 流式工具预执行；分层配置 + AGENTS.md/CLAUDE.md 注入 | 4.1 / 4.10 | 主循环可流式执行工具；配置分层生效；`--config` 覆盖 |
| Phase 2（上下文） | 多级压缩流水线 + 大结果落盘 + usage 锚点 token 估算 | 4.2 | 长会话不再「丢历史」；工具大输出落盘可回读 |
| Phase 3（编辑） | edit_file（search-and-replace）+ 编辑前读取 + 危险路径保护 | 4.3 / 4.4.3 | 精确编辑不幻觉；敏感路径被拦截 |
| Phase 4（安全） | 权限模式 + allow/deny/ask 规则 + Bash 命令分析 | 4.4 | 危险命令/越界被 deny 或询问 |
| Phase 5（多 Agent） | 子 Agent（sync/async）+ 上下文隔离 | 4.5 | 主 Agent 可委派并收到摘要 |
| Phase 6（跨会话） | 持久化记忆 + 结构化任务 + 会话持久化/Resume | 4.6 / 4.8 / 4.9 | 重启后可 resume；记忆跨会话保留 |
| Phase 7（可扩展） | Hooks + 可观测性 | 4.7 / 4.11 | Hook 可阻止/改写工具调用；token/成本可导出 |
| Phase 8（进阶） | apply_patch、Skill、MCP、Plan 模式、沙箱、Worktree、插件系统、多 Agent 通信协议 | 4.3.3 / 4.12-4.15 | 按需逐步引入 |

---

## 6. 参考资料

- OpenAI Codex 官方仓库（开源）：https://github.com/openai/codex
- Codex CLI 架构文档（官方 docs 镜像）：https://mintlify.wiki/openai/codex/architecture/overview
- Codex 源码深度研究（xiaonancs，Rust/TS/SDK 全貌，25 章）：https://github.com/xiaonancs/codex-source-analysis
- Claude Code 架构分析（how-claude-code-works，16+ 篇专题）：https://github.com/Windy3f3f3f3f/how-claude-code-works
- Claude Code 512K LOC 逆向（awesome-cc-harness，16 章）：https://github.com/WanLanglin/-awesome-cc-harness
- Claude Code 官方文档（Skills/Subagents/Hooks/MCP/CLAUDE.md）：https://code.claude.com/docs/zh-CN/features-overview

> 注：Claude Code 核心 CLI 为闭源，本设计中对 Claude Code 的描述来自社区对 npm 发布物（约 51 万行 TypeScript）的逆向分析与官方文档；Codex 部分来自 `openai/codex` 开源仓库源码。所有「对齐」均以其公开、可核验的架构/源码为依据。
