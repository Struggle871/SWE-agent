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
- M4 及以后：Session/Turn 状态机、Transcript/Resume/Fork、任务图、Hooks、Skills、MCP、多 Agent 和可观测性，规划中。

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

## 内置工具

| 工具 | 用途 |
| --- | --- |
| `read_file` | 读取工作区内 UTF-8 文本文件，可指定行区间 |
| `list_dir` | 列出工作区目录内容和类型 |
| `search_files` | 按 glob 文件名模式递归搜索 |
| `search_content` | 在文本文件中按正则搜索内容 |
| `write_file` | 创建或覆盖工作区内 UTF-8 文本文件，可追加 |
| `edit_file` | 将唯一 `old_string` 精确替换为 `new_string` |
| `run_command` | 在持久 Shell 会话中执行命令并返回输出和退出码 |
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

`CommandAnalyzer` 现在通过目标 Shell adapter 解析 tokenizer/AST，按子命令合并风险，识别引号、转义、命令链、重定向、嵌套子 Shell、动态展开和工作区路径。它仍不是操作系统本身；`LocalSandboxProvider` 只提供 cwd、过滤环境、退出状态、超时和取消能力，平台级隔离需替换为 OS adapter。

## 审批与沙箱

审批和运行时隔离是两层机制：

- `ApprovalBroker` 决定用户是否同意当前 Preview 描述的操作。
- 审批后系统重新计算路径、权限、命令分析结果和文件 hash；状态变化会使旧审批失效。
- 当前版本没有 OS 级 sandbox。批准任意 Shell 命令仍代表用户接受该命令可能产生的系统级副作用。
- `SandboxProvider` 表达文件系统、网络、子进程、工作目录、环境变量、超时和取消能力；能力不足不会静默执行未隔离命令。

## 持久终端

`run_command` 使用持久 Shell 子进程：

- Windows 使用 `cmd.exe`，Unix 使用 `/bin/bash`。
- `cd`、环境变量和后台任务输出可以在同一会话中保留。
- 命令超时后会终止进程树并重启 Shell，会话状态回到初始工作目录。
- 当前安全层仍以 `workspaceRoot` 作为命令静态分析和 sandbox adapter 的 CWD；持久 Shell 的 canonical CWD 状态模型属于后续 M4 的改进范围。

## Token 用量与上下文

- Agent 会估算中英文内容的 Token 占用，并结合模型 usage anchor 监测上下文预算。
- 工具结果过大时会落盘到 `.swe-agent/session/`，上下文中只保留受限预览。
- 达到上下文阈值时执行压缩，尽量保留用户目标、最近消息和近期文件状态。
- 当前压缩不是完整的持久化 Transcript checkpoint；Resume/Fork 属于后续里程碑。

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
```

配置优先级为：内置默认值、用户级 `~/.swe-agent/config.toml`、项目级 `.swe-agent/config.toml`、`.env`/环境变量/CLI 覆盖，后者优先级最高。

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

当前基线为 38 项测试全部通过。

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
