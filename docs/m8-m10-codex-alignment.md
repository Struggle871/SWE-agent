# M8-M10 Codex 源码对照与实施设计

## 1. 目的与证据边界

本文把 M8-M10 从功能清单细化为可执行的端到端设计。对照基线是工作区
`tmp/openai-codex-source` 的提交 `2c4a95736bea64256a50f7b8506bd33c181cc85a`。本轮尝试访问
OpenAI Docs 和 Codex manual 时分别得到 HTTP 403 与 Windows TLS credential 错误，因此本文不声称已验证
2026-09-09 的在线官方页面；公开概念边界参考本机 `openai-docs` manual 索引，具体实现判断以该源码提交为准。

借鉴原则不是复制 Rust 目录，而是复用经过验证的不变量：控制面与执行面分离、状态先持久化再对外可见、
动态扩展通过统一 registry/spec plan 生效、任何扩展都不能绕过工具安全链。

## 2. Codex 的关键设计与本项目取舍

### 2.1 多 Agent

Codex 将能力拆成四层：`spawn_agent/send_message/wait_agent/list_agents/interrupt_agent/followup_task` 是模型可见
工具；Agent control 拥有 child thread 和状态；state migration `0021_thread_spawn_edges.sql` 保存父子关系；
worktree crate 用版本化 owner metadata 把 managed worktree 绑定到 thread。`spawn_agent` 还显式处理继承全部历史、
不继承、只继承最近 N turns，子模型覆盖、角色限制和 canonical task path。

本项目不复制 Codex 的 ThreadManager。M8 使用 `AgentManager` 作为本地 child session owner，复用现有
`AgentSession/TranscriptStore`；`TaskGraphStore` 是任务真源；mailbox 是独立 append-only 文件。这样解决的实际问题是
子任务状态、父子结果和崩溃边界可恢复，而不是为了获得同名类型。

调用流程：

```text
model tool call
 -> ToolRouter 安全链
 -> spawn_agent
 -> 创建独立 ShellSession + 不共享 workingMemory 的 AgentContext
 -> 创建 child AgentSession 和 child transcript
 -> 先持久化 child metadata
 -> 异步执行 child turn
 -> 持久化 completed/failed/cancelled + result summary
 -> wait_agent 返回结构化状态
```

消息流程：`send_message -> mailbox durable append -> child Session.steer -> 下一次 sampling boundary 注入`。
进程重启发现 `starting/running` child 时，先标记为明确失败，且不自动重放未知工具调用。

当前实现已补齐跨进程 revision/claim lock、父取消传播、`none/all/N turns`、managed Git worktree、写冲突检测和统一
`agent_event` 投影。崩溃恢复采用 fail-closed：未知在途 child 明确失败，不自动重放可能产生副作用的工具；自动 child
resume 不属于当前安全口径。

### 2.2 Hooks

Codex 的 hooks crate 分为 declaration/discovery、registry、dispatcher、command runner、MCP runner、事件 schema 和
output parser。事件覆盖 SessionStart/End、UserPromptSubmit、Pre/PostToolUse、PermissionRequest、Pre/PostCompact、
Interrupt、Stop 和 SubagentStart/Stop。Hook output 可以 block、提供 additional context 或修改受允许的输入；运行状态也
投影为可恢复的 lifecycle item。

本项目 M9 采用相同职责边界，但 Hook 不直接访问 `SessionCoordinator`。完整流程必须是：

```text
canonical lifecycle event
 -> immutable HookInput snapshot
 -> matcher 选择 + trust/hash 校验
 -> preview（handler、命令/MCP、权限、timeout）
 -> ToolRouter/Approval/Sandbox
 -> bounded output parser
 -> apply allow/block/rewrite/additionalContext
 -> transcript + audit
 -> UI/CLI event projection
```

验收包含：PreToolUse block 后 runtime 未执行；rewrite 后重新 schema/preflight；timeout 根据 fail-open/fail-closed 策略
处理；输出超限 spill；中断会杀死 hook 进程树；重启可以还原已完成 hook item。只有 command 和真实 MCP handler 均从
公开 Session 路径通过测试后才算 Hooks 完成。

### 2.3 MCP

Codex 不把 MCP 当作 Skill transport。`ConnectionManager` 管理多个 server 的连接 identity、启动状态、认证和 refresh；
catalog 独立分页并限制页数、条目数、cursor bytes、重复 cursor 和总 timeout；OAuth 有 discovery、credential store、
refresh transaction 和锁；App Server 提供 status、refresh、OAuth login、resource read、tool call、elicitation 和 event stream。

本项目 MCP 已覆盖官方 SDK stdio/Streamable HTTP、resource/tool/prompt/template/subscription、bounded pagination、重复
cursor/条目/总时限防护、listChanged、degraded/reconnect 和 client-credentials credential store。M9 完整流程为：

```text
config/plugin overlay
 -> connection plan（严格校验且不修改 live registry）
 -> parallel startup + per-server state
 -> bounded paginated catalogs
 -> atomic registry/spec-plan swap
 -> call/resource/prompt/elicitation
 -> disconnect -> degraded + bounded retry/jitter
 -> config refresh -> diff -> add/reuse/remove -> atomic swap
```

动态 add/remove 已通过 App Server 审批入口、持久 overlay 和 atomic registry generation 接通。剩余平台缺口是
OAuth discovery、跨进程刷新锁和更完整的独立 CLI。一个 server 失败只降级该 server；MCP generation 在
swap 前保持旧 catalog，在途调用由 registry lease 排空。

### 2.4 Plugin 与 Marketplace

Codex 将 Plugin 视为 skills、tools、hooks、MCP、apps 和权限元数据的声明式 bundle；App Server 协议暴露 list/read/
install、availability、disabled reason、install policy 和 marketplace add/remove/upgrade。核心原则是先建立 activation plan，
校验成功后一次性提交，而不是边解析边污染全局 registry。

本项目 Marketplace 已有 search/semver/hash/staging/install/upgrade/enable/disable/uninstall；active plugin 已把 Skill、Tool、
Hook 和 MCP contributions 编译为 generation。当前实现遵守：

1. manifest contribution 包含 namespaced tools、hooks、MCP overlay、权限和内容 identity。
2. 全量冲突、schema、trust、依赖和权限校验后才切换 live registry。
3. disable/upgrade 生成新 generation，新 request 不再解析到旧工具。
4. 在途调用保留旧 runtime lease，结束后才关闭旧 provider；失败 activation 不改变当前 generation。
5. App Server 管理操作经过 preview/approval/audit；失败操作恢复 registry 记录和磁盘版本。

剩余改进是把 CLI 和 App Server 的插件 lifecycle event 完全统一到同一个 durable projection。

### 2.5 高级持久化

Codex 同时保留 append-only rollout 和 SQLite query projection。spawn edge、thread metadata、archive 状态等进入 migration；
fork 通过明确的 turn boundary 截取历史，状态数据库是查询/关系投影而不是模型历史的唯一真源。

本项目继续以 JSONL transcript 为真源，分期增加：

- M8：task graph、child registry、mailbox、parent/child edge；当前已有单进程版本。
- M9：hook/MCP/plugin lifecycle kinds、跨进程 writer/claim lock、schema migration runner。
- M10：SQLite projector，记录 session/turn/tool/task/agent 索引、archive/delete tombstone 和 lineage；删除 DB 后可从
  transcript 重建。
- M10：reference/paginated fork 只存 parent session、ordinal/byte offset 和 immutable parent hash；父历史不匹配时 fail
  closed。archive/revert/delete 必须是显式命令并写 tombstone，不能物理删除唯一证据。

### 2.6 Memory、Observability 与 App Server

Memory 是带 provenance/confidence/lifecycle 的结构化 source，不等同于 `workingMemory` 或 AGENTS。提取只产生候选，
consolidation 负责去重、冲突和删除；retrieval 结果以 contextual fragment 注入并参与 identity/audit。

可观测性从 canonical lifecycle event 投影，不能在各模块重复埋一套状态。首版指标包括 request TTFT/latency/retry、
token/cache、tool queue/wait/run、approval、compaction、task/agent 成功率、MCP health 和 sandbox violation；日志字段统一
携带 session/turn/request/call/task/agent id，正文和 secret 不进入 metric labels。

App Server 使用 JSON-RPC 控制面和事件流数据面：initialize 协商版本；session create/resume/fork；turn start/steer/
interrupt；approval request/result；transcript 分页；tool/skill/MCP/plugin/task status。连接断开不取消 session，重连用
event cursor 补发；慢消费者有 bounded buffer 和 gap notification。前端只依赖协议 DTO。

### 2.7 Sandbox 与真实验证

当前 `LocalSandboxProvider` 是 best-effort，Docker 只覆盖 Windows 路径。后续 provider 必须公开实际能力而非请求能力：
Linux 使用 namespace/seccomp/cgroup 或受管容器，macOS 使用 seatbelt，Windows 使用受限 token/job object/ACL 或受管
容器。网络、文件系统和 process tree 任一关键能力缺失时 required profile 拒绝运行。

验证分三层，不能互相替代：确定性 contract tests；本机真实进程/MCP/sandbox integration；需要凭据的真实模型 smoke
与 benchmark。CI 至少覆盖 Windows/Linux、Node LTS、`npm run check`、MCP conformance fixture、sandbox capability probe 和
SWE-bench 子集；真实模型验证报告 model、request id、usage、重试和费用上限，FakeModel 结果不得计入模型完成度。

## 3. 分期与完成状态

M8 已按 durable DAG、跨进程冲突、fork mode、父取消、worktree 和明确崩溃语义完成验收。M9 的 Hooks 与 Plugin atomic
activation 已闭环，MCP transport/catalog/lifecycle、动态管理、OAuth/PKCE 与 elicitation 主路径可用。M10 的
Memory 与 App Server 首版已闭环，可观测性已有 SQLite 事件、TTFT/latency/token/cache/tool/turn/compaction 指标，但 cost、
更细的 retry/sandbox 指标和服务端认证仍需硬化。状态必须继续按这些功能边界描述，不能把 M9/M10 整体写成完成。

## 4. 端到端验收门槛

每个切片必须同时具备：CLI 或模型工具/App Server 公开入口、真实 runtime 装配、成功与失败路径、取消/timeout、持久化或
恢复、audit/lifecycle event，以及从公开入口出发的集成测试。只有 interface、adapter、manifest 字段、mock transport 或
FakeModel 协议测试时，状态只能写“基础设施”或“未完成”。
