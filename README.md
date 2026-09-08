# Minimal SWE Agent

一个基于 TypeScript 的命令行 SWE Agent 原型。

## 快速开始

安装依赖：

```powershell
npm install
```

复制 `.env.example` 为 `.env`，填写模型供应商的 API Key。未设置 API Key 时，程序默认使用 FakeModel 运行本地演示。

启动 Agent：

```powershell
npm run build
node dist/index.js "你的任务描述"
```

恢复已有会话或创建 copied fork：

```powershell
node dist/index.js --resume <sessionId> "继续任务"
node dist/index.js --fork <sessionId> --at <ordinal> "从该历史分支继续"
```

使用 FakeModel 演示：

```powershell
$env:USE_FAKE_MODEL="true"
node dist/index.js "请查看当前目录结构，然后给出最终结论"
```

## 当前状态

当前版本为 v0.4 单 Agent 原型：

- Phase 1：任务规划、ReAct/JSON 输出解析、流式模型输出、文件/搜索/终端工具，已完成原型。
- Phase 2：Token 估算、工具结果落盘、上下文压缩、分层配置和项目记忆注入，已完成原型。
- Phase 3 M0：工程基线和回归测试，已完成。
- Phase 3 M1：工具 preflight、执行预览、权限审批、审批后复检、工作区校验、文件 hash 和审计，已接入主执行链。
- Phase 3 M2：typed session/turn/step/request/call IDs、结构化 ResponseItem、ModelTransport 事件流、原生 tool call、usage/request 关联和 legacy Chat/ReAct 适配，已完成。
- Phase 3 M3：ToolSpec/ToolRuntime/ToolRegistry 分离、ToolRouter、schema 字段路径校验、读写并发 gate，已接入主执行链。
- Phase 3 M3.5：Shell tokenizer、命令链 AST、子命令风险合并和可替换 SandboxProvider，已接入主执行链。当前内置 `LocalSandboxProvider` 是跨平台受限子进程 adapter，不宣称 OS 级沙箱；动态语义和缺失能力会保守拒绝。
- Phase 3 安全闭环 S0/S1：Sandbox capability 已区分 best-effort 与实际强制等级，`SandboxManager` 已接入命令准入，执行请求携带规范化 `SandboxProfile`。
- Phase 3 Windows strict S2：Windows 默认使用 `WindowsDockerSandboxProvider`，固定启用 `network=none`、只挂载工作区、只读 rootfs、丢弃 capabilities、禁止提权和容器清理；Docker 不可用时不会静默退回裸 Shell。`SWE_SANDBOX_MODE=best-effort` 才启用本地 adapter。
- macOS/Linux OS provider：延期，当前非 Windows CLI 使用不可用 provider 并拒绝命令执行；不会添加未实现的跨平台空壳。
- Phase 3 M4：工作区已有 SessionCoordinator/TurnRunner、输入优先级队列、单 active turn、steer 和取消传播原型，但按当前项目阶段口径仍属于规划/验收中，不能标记为已实现。
- Phase 3 M5：工作区已有 JSONL Transcript、Resume、copied Fork、reconstruction 和轻量索引原型，但尚未按里程碑标记完成；SQLite、reference/paginated fork、archive/revert、持久化队列/mailbox、L3 trace 等仍按后续阶段规划。设计边界见 [`docs/m5-transcript-resume-fork.md`](docs/m5-transcript-resume-fork.md)。
- Phase 3 M6：工作区已落地持久化 context checkpoint、pre/mid/manual compaction、local/remote/remote-v2/new-context backend、window lineage、world/reference baseline、replacement-history Resume/Fork/rollback replay 和 durable-before-live 故障边界，并通过 M6 专项测试。由于 M4/M5 尚未按路线图顺序完成发布验收，这里记录为“实现已验证”，不改写整体里程碑发布状态。完整约束与实现映射见 [`docs/m6-context-checkpoint-compaction.md`](docs/m6-context-checkpoint-compaction.md)。
- Phase 3 M7：已接入 contextual fragments 的运行时基础（AGENTS/Skills catalog、显式 skill body、world-state fingerprint），但完整配置层 provenance、managed requirements、trust gating 和 Skills enablement 仍未完成，不能标记为 M7 完成。设计见 [`docs/m7-config-agents-skills.md`](docs/m7-config-agents-skills.md)。
- M8 及以后：任务图、多 Agent、Hooks、MCP 和可观测性，规划中。

## 功能更新日志

### v0.2 · 2026-08-28

- 完成 M0 测试基线，使用 Node 内置测试运行器执行单元和集成测试。
- 接入统一工具执行前链路：参数 schema 校验、输入规范化、工作区路径校验、命令风险分析、Preview、权限决策、审批、审批后复检和 Audit。
- 增加 canonical path 校验，检测工作区外路径、符号链接/junction 穿透、大小写差异和 NTFS alternate data stream。
- 增加文件 read-before-edit、内容 hash/metadata snapshot、精确编辑歧义检查和审批后状态变化检测。
- 增加 `write_file`/`edit_file` 的 unified diff 预览和同目录临时文件原子写入。
- 增加 `CliApprovalBroker` 与 `StaticApprovalBroker`，支持一次批准、本会话同类操作批准和默认拒绝。
- 增加 JSONL 审计记录，对 API key、token、password、完整内容和 diff 做脱敏或省略。
- 修复命令分析 `ask` 被只读权限策略降级为 `allow` 的问题；Preflight 现在按 `deny > ask > allow` 合并最低安全限制和环境权限策略。

### v0.3 · 2026-08-30

- 增加 `src/protocol/`：branded session/turn/step/request/call IDs、ResponseItem、ModelEvent、ModelTransport、usage 和 AgentError 判别联合。
- 核心 step 现在消费 provider-neutral `ModelEvent`；原生 tool call 使用模型提供的稳定 call id，继续进入 M1 的 preflight、approval、revalidation、runtime 和 audit 链路。
- FakeModel 提供结构化 tool call 事件流；OpenAI Chat Completions 解析原生 tool-call SSE，并保留旧 JSON/ReAct 文本兼容路径。
- usage 事件带有 request id 关联；新增 M2 协议、SSE 和端到端安全链路测试。

### v0.4 开发记录 · 2026-09-03（未标记 M4/M5 完成）

- 新增 `SessionCoordinator`，统一管理 session 生命周期、输入队列、turn 串行化和 session 级关闭。
- 新增 `TurnRunner`，将单个 turn 拆分为上下文准备、压缩、采样、工具派发、后续采样和 terminal state。
- `AgentSession` 改为兼容 facade；并发 `run` 请求不会创建两个 active turn。
- `interrupt`、`shutdown` 和调用方 `AbortSignal` 会传播到模型请求、审批等待和工具 runtime。
- 新增 steer 输入，在下一次 sampling request 前注入历史。
- 新增明确的 turn terminal reason、session/turn 状态事件和 step continue reason。
- M4 原型增加并发运行、模型取消、工具取消、steer 和输入优先级测试；这些测试通过不等于里程碑已按完整设计验收。

### M6 工作区实现记录 · 2026-09-05

- `SessionCoordinator` 持有唯一 annotated `ContextManager`；`TurnRunner` 只使用短期请求快照，消息先写 transcript 再进入 live context。
- schema v2 checkpoint 保存完整 replacement history、window lineage、token usage 和 resource origin；读取端兼容 v1，Resume/Fork/rollback 从最新 surviving checkpoint 重放。
- 支持 local model handoff、Responses `/responses/compact` remote adapter、capability-driven remote-v2 transport 和 new-context backend；`PromptBuilder` 不再静默截断历史。
- checkpoint durable append 成功后才安装 live replacement；baseline 写失败保留新 checkpoint、关闭当前 session，并由 Resume 强制 full context injection。
- 大工具结果在进入 transcript/history 前写入 session-scoped、call-scoped、SHA-256 内容寻址 artifact，只保留有界 preview 和引用。
- PreCompact/PostCompact、超时、取消、shutdown、transient retry、compact request overflow、invalid replacement、no-progress guard 和写入故障均进入结构化控制流。

## 内置工具

| 工具 | 用途 |
| --- | --- |
| `read_file` | 读取工作区内 UTF-8 文本文件，可指定行区间 |
| `list_dir` | 列出工作区目录内容和类型 |
| `search_files` | 按 glob 文件名模式递归搜索 |
| `search_content` | 在文本文件中按正则搜索内容 |
| `write_file` | 创建或覆盖工作区内 UTF-8 文本文件，可追加 |
| `edit_file` | 将唯一 `old_string` 精确替换为 `new_string` |
| `run_command` | 在沙箱 provider 控制的执行环境中运行命令并返回输出和退出码 |
| `read_terminal_output` | 读取持久终端中尚未消费的输出 |

新增工具必须在 `src/tools/` 实现，并通过 `ToolRegistry` 注册。

## 工具权限

工具执行前会经过统一安全链路：

```text
参数校验与规范化
-> WorkspacePolicy / CommandAnalyzer
-> 风险分类
-> PermissionPolicy
-> 执行预览
-> allow / ask / deny
-> ApprovalBroker
-> 审批后复检
-> 工具执行
-> 审计
```

当前默认行为：

- 读取和搜索默认 `allow`，但仍产生 Preview 和 Audit。
- 文件写入默认 `ask`，审批预览包含 canonical path 和 diff。
- 普通命令执行默认 `ask`。
- 网络访问、依赖安装和破坏性命令默认 `ask`。
- 明确越界路径、严重破坏命令和 bypass-immune 路径直接 `deny`。
- 非交互终端无法安全询问用户时，审批默认拒绝。

`CommandAnalyzer` 现在通过目标 Shell adapter 解析 tokenizer/AST，按子命令合并风险，识别引号、转义、命令链、重定向、嵌套子 Shell、动态展开和工作区路径。它仍不是操作系统本身。Windows strict 模式由 `WindowsDockerSandboxProvider` 提供容器边界；`LocalSandboxProvider` 只提供 cwd、过滤环境、退出状态、超时和取消能力。

## 审批与沙箱

审批和运行时隔离是两层机制：

- `ApprovalBroker` 决定用户是否同意当前 Preview 描述的操作。
- 审批后系统重新计算路径、权限、命令分析结果和文件 hash；状态变化会使旧审批失效。
- Windows strict 模式提供容器级文件系统、网络和进程边界；native Windows ACL/restricted token/WFP 后端尚未实现。
- `LocalSandboxProvider` 仍不是 OS 级 sandbox。只有显式选择 `best-effort` 时才会使用它。
- `SandboxProvider` 表达文件系统、网络、子进程、工作目录、环境变量、超时、取消和实际 enforcement；能力不足不会静默执行未隔离命令。

## 终端执行

当前 CLI 的 `run_command` 使用 provider-owned 的一次性命令执行：

- Windows strict 使用 Docker Desktop worker，工作区挂载到容器 `/workspace`，默认网络关闭。
- 命令超时或取消时会删除容器并终止 Docker CLI 进程树。
- `ShellSession` 仍作为兼容终端缓冲区保留；它不是 strict `run_command` 的安全执行环境。
- provider-owned persistent session 仍是后续改进项，不能把当前兼容 Shell 声明为受沙箱保护的持久会话。

Windows strict 配置：

```powershell
$env:SWE_SANDBOX_IMAGE="node:22-bookworm-slim"
node dist/index.js "运行测试"
```

显式使用 best-effort 本地 adapter：

```powershell
$env:SWE_SANDBOX_MODE="best-effort"
node dist/index.js "查看目录"
```

## Token 用量与上下文

- Agent 从实际 model request 投影估算 system/history/tool schema/output reserve，并以关联 request/history version/window id 的 provider usage 作为锚点。
- hard context limit 与 auto-compact limit 分离，支持 `total` 和 `body_after_prefix` scope；同一窗口、原因和 phase 的自动尝试有熔断保护。
- 工具结果过大时会落盘到 session transcript 根目录下的 `artifacts/<sessionId>/tool-results/`，上下文和 transcript 只保留受限预览、hash 和 durable path。
- 达到阈值、模型 context 下调或 comp-hash 改变时，系统执行可恢复 checkpoint compaction；canonical JSONL 仍保持 append-only。
- `AgentSession.compact()` 提供串行化 manual compact，`AgentSession.rollback(ordinal)` 追加 rollback 记录并使用同一 reconstruction contract。

## 配置说明

默认模型配置：

```text
MODEL_BASE_URL=https://open.bigmodel.cn/api/paas/v4
MODEL_API_KEY=你的智谱APIKey
MODEL_NAME=glm-4.7-flash
```

常用运行配置：

```text
USE_FAKE_MODEL=true
MAX_STEPS=20
MAX_CONTEXT_TOKENS=8000
MAX_OUTPUT_TOKENS=4096
TOOL_TIMEOUT_MS=30000
PARSE_RETRY=2
WORKSPACE_ROOT=.
USE_LLM_PLANNING=false
COMPACTION_BACKEND=auto
AUTO_COMPACT_TOKEN_LIMIT=6400
AUTO_COMPACT_LIMIT_SCOPE=total
COMPACTION_FALLBACK_BUFFER_TOKENS=512
COMPACTION_TIMEOUT_MS=60000
COMPACTION_MAX_RETRIES=2
```

当前已实现的原型配置优先级为：内置默认值、用户级 `~/.swe-agent/config.toml`、cwd 项目级 `.swe-agent/config.toml`、`.env`/环境变量/调用方覆盖，后者优先级最高。当前 local 层会重新带入默认值，可能覆盖 user/project；完整 TOML、provenance、managed requirements、project trust 与 session flags 尚待 M7 修复，不能把本段当作目标架构。目标设计见 [`docs/m7-config-agents-skills.md`](docs/m7-config-agents-skills.md)。

## 测试与构建

```powershell
npm run typecheck
npm test
npm run build
```

一次执行全部检查：

```powershell
npm run check
```

当前基线为 54 项测试全部通过。

## 目录结构

```text
src/core/       AgentSession、turn、executor、上下文和任务调度
src/model/      FakeModel 与 OpenAI 兼容模型客户端
src/tools/      工具实现、注册、preflight、preview 和原子写入
src/security/   工作区、命令、权限、审批和审计
src/config/     TOML 分层配置与 AGENTS.md/CLAUDE.md 加载
tests/unit/     单元测试
tests/integration/  集成测试
docs/           对齐设计、开发路线和阶段学习笔记
```

详细开发规划见 [`docs/development-roadmap-v2.md`](docs/development-roadmap-v2.md)，M0/M1 实现记录见 [`docs/m0-m1-implementation.md`](docs/m0-m1-implementation.md)。
