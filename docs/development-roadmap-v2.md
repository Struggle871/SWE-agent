# minimal-swe-agent v2 详细开发规划

> 日期：2026-08-27  
> 基准设计：[alignment-design-v2.md](./alignment-design-v2.md)  
> 适用状态：Phase 1、Phase 2 已形成原型，Phase 3 只完成部分编辑安全能力  
> 目标：把当前 demo 逐步演进为可测试、可审计、可恢复、可扩展的 TypeScript SWE Agent

## 0. 如何使用这份规划

这不是“把所有模块一起重写”的计划。正确开发方式是：

1. 每个里程碑只建立一到两个新的系统不变量。
2. 新旧实现短期并存，通过 adapter 保持 CLI 可运行。
3. 每个里程碑结束时必须有自动化测试和一个端到端演示。
4. 只有当前里程碑验收通过，才进入下一个里程碑。
5. 每次提交前必须执行：

```powershell
npm run typecheck
npm run build
npm test
```

这份规划中的时间按一名开发者全职计算。若以学习为主、每天投入两到三小时，日历时间建议乘以二到三倍。

## 1. 当前阶段判断

### 1.1 当前可以工作的能力

当前代码已经能够完成一条最小 Agent 链路：

```text
用户请求
-> AgentSession
-> PromptBuilder
-> 模型流式文本
-> OutputParser
-> 单个工具执行
-> 工具结果写回历史
-> 模型生成 final_answer
```

已验证：

- `npm run typecheck` 通过。
- `npm run build` 通过。
- `USE_FAKE_MODEL=true node dist/index.js ...` 可以完成一轮工具调用。
- `AgentSession` 和 `runTurn` 已拆分。
- 支持模型文本 SSE、JSON/ReAct 输出解析和有限解析重试。
- 支持文件读写、精确字符串编辑、目录和内容搜索、持久终端。
- 已有 read-before-edit、mtime 检查和部分敏感路径拒绝。
- 已有大工具结果落盘、usage 锚点和四级上下文压缩雏形。
- 已有简化的分层配置、`AGENTS.md`/`CLAUDE.md` 注入。

### 1.2 当前不能宣称已完成的能力

以下模块只有类型、注释或局部代码，不能视为完整能力：

- `StreamingToolExecutor` 没有接入真实模型 tool call 流。
- `ContinueReason` 没有驱动状态机。
- 没有工具执行前预览和用户审批。
- 没有完整工作区信任、真实路径和符号链接校验。
- shell 和搜索工具可以绕开现有工作区边界。
- 没有 tool schema 运行时验证。
- 没有 ToolRouter、model-visible spec 和 runtime 分离。
- 没有 append-only transcript、resume、fork 和崩溃恢复。
- 压缩不是持久化 checkpoint，恢复后无法重建相同语义。
- 任务调度仍是栈，没有依赖图和持久化。
- 没有 hooks、skills、MCP、多 Agent、记忆和 sandbox 闭环。
- 没有自动化测试目录和 `npm test`。
- 当前目录没有 `.git`，无法形成可靠的小步提交和回滚基线。

### 1.3 当前准确阶段

建议把项目标记为：

```text
v0.2：单 Agent 原型
Phase 1：执行循环骨架       已完成原型
Phase 2：上下文预算骨架     已完成原型
Phase 3：工具安全与审批     M0/M1 已完成，M3.5 规划已补充
生产可用性                 尚未开始
```

下一步不是继续增加工具，而是先完成工程基线和 Phase 3。

## 2. 总体开发顺序

建议采用以下顺序：

```text
M0 工程基线与回归测试
 -> M1 最小静态分析 + 正确的审批闭环
 -> M2 协议类型和模型事件
 -> M3 Runtime 分离
 -> M3.5 Shell tokenizer、命令链 AST、风险合并、SandboxProvider
 -> M4 在稳定安全执行模型上实现 Session / Turn 状态机和取消
 -> M5 Transcript / Resume / Fork
 -> M6 上下文 checkpoint 与压缩
 -> M7 配置、AGENTS、Skills
 -> M8 任务图与多 Agent
 -> M9 Hooks、MCP、插件
 -> M10 记忆、可观测性、App Server
```

必须保持这个依赖方向。尤其不要在 M5 之前实现复杂多 Agent：没有 transcript 和 resume 时，子 Agent 的状态、结果和失败无法可靠审计。

## 3. M0：工程基线与回归测试

预计：2 到 3 个开发日。

目标：在改变架构前冻结当前可用行为，后续重构能够证明没有破坏基础功能。

### 3.1 建立版本控制基线

当前目录不是 Git 仓库。第一步应确认它是否本应属于上层仓库：

```powershell
git rev-parse --show-toplevel
```

若确认这是独立项目，再初始化仓库并提交当前基线。不要把 `node_modules/`、`dist/`、`.env`、`.swe-agent/` 和下载的参考源码提交进去。

补充 `.gitignore`：

```text
node_modules/
dist/
.env
.swe-agent/
coverage/
tmp/
*.log
```

`tmp/openai-codex-source` 只是研究材料，不应成为项目源码的一部分。

### 3.2 建立测试框架

保持项目轻量，优先使用 Node 内置 `node:test` 和现有 `tsx`。建议目录：

```text
tests/
├── unit/
│   ├── output-parser.test.ts
│   ├── token-estimator.test.ts
│   ├── compaction-pipeline.test.ts
│   ├── layered-config.test.ts
│   ├── agents-md.test.ts
│   ├── path-policy.test.ts
│   └── file-state-cache.test.ts
├── integration/
│   ├── file-tools.test.ts
│   ├── terminal-tool.test.ts
│   ├── agent-session-fake.test.ts
│   └── context-compaction.test.ts
└── fixtures/
```

新增脚本：

```json
{
  "test": "tsx --test tests/**/*.test.ts",
  "test:unit": "tsx --test tests/unit/**/*.test.ts",
  "test:integration": "tsx --test tests/integration/**/*.test.ts",
  "check": "npm run typecheck && npm run test && npm run build",
  "smoke": "node dist/index.js \"请查看当前目录结构，然后给出最终结论\""
}
```

当前环境中 `npm run demo` 的 `tsx` 启动曾遇到 `uv_os_get_passwd ENOMEM`，而编译后的 `node dist/index.js` 正常。应把它记录为开发环境问题，不能误判为 Agent 主循环错误。

### 3.3 冻结现有行为

M0 至少覆盖这些测试：

- JSON action 能正确解析。
- ReAct action 能回退解析。
- 未知工具被拒绝。
- 连续解析失败按 `parseRetry` 终止。
- `edit_file` 在 old string 不唯一时拒绝。
- 未读取的既有文件不能写。
- 文件读取后被外部修改时编辑被拒绝。
- 路径 `../outside.txt` 被拒绝。
- 大工具结果超过阈值后落盘并返回预览。
- FakeModel 完成一次工具调用后结束。
- shell timeout 后 session 能恢复或明确失败。

### 3.4 M0 完成标准

- 存在可重复运行的 `npm test`。
- `npm run check` 一次通过。
- 所有测试使用临时目录，不污染仓库。
- 当前 FakeModel 演示有端到端测试。
- 没有开始修改核心协议。

## 4. M1：工具预检、预览、审批与工作区校验

预计：4 到 6 个开发日。

这是当前最优先的功能阶段，直接解决“执行前能否看到影响、谁批准、操作是否仍在工作区内”。

### 4.1 建立统一预检协议

新增：

```text
src/security/
├── workspace-policy.ts
├── command-policy.ts
├── permission-policy.ts
├── approval-broker.ts
└── audit.ts

src/tools/
├── preflight.ts
└── preview.ts
```

核心类型：

```ts
type ToolDecision = "allow" | "ask" | "deny";
type ToolRisk = "read" | "write" | "execute" | "network" | "destructive";

interface ToolExecutionPreview {
  callId: string;
  toolName: string;
  summary: string;
  risk: ToolRisk;
  cwd: string;
  affectedPaths: string[];
  command?: string;
  diff?: string;
  reasons: string[];
}

interface ToolPreflightResult {
  decision: ToolDecision;
  preview: ToolExecutionPreview;
  normalizedInput: Record<string, unknown>;
  permissionFingerprint: string;
}
```

所有工具统一经过：

```text
validate input
-> normalize input
-> workspace/path preflight
-> command/risk analysis
-> build preview
-> allow / ask / deny
-> approval
-> revalidate
-> execute
-> audit
```

### 4.2 完成真实工作区校验

现有 `resolveInWorkspace` 只是字符串前缀校验，需要替换为 `WorkspacePolicy`：

- 将 workspace root 转成绝对规范路径。
- 对已存在目标使用 `realpath`，检测符号链接穿透。
- 对新文件规范化并校验其最近存在父目录的真实路径。
- Windows 比较时处理路径大小写和盘符。
- 拒绝 NTFS alternate data stream。
- 区分 readable roots 和 writable roots。
- 支持多个 workspace root，但默认只有项目根。
- 敏感路径规则在 canonical path 上匹配。
- `.git`、凭据、用户配置等 bypass-immune 路径永远不能被普通审批放行。
- `search_files` 和 `search_content` 必须改用相同的策略。
- 目录遍历遇到无权访问、循环符号链接时返回结构化错误。
- shell 的 cwd 必须持续处于允许的 workspace 中。

先不要尝试用路径校验替代 OS sandbox。路径策略只解决 Agent 自己发起的文件操作，不能约束任意 shell 子进程。

### 4.3 命令风险分析：M1 最小静态分析

M1 不需要一次实现完整 shell AST，但要建立可替换接口：

```ts
interface CommandAnalyzer {
  analyze(command: string, cwd: string): CommandAssessment;
}
```

首版至少识别：

- `cd` 和绝对路径。
- `..` 越界。
- 管道、重定向和后台执行。
- 删除、移动、覆盖、格式化和权限修改。
- 网络下载和包安装。
- PowerShell `Invoke-Expression`、命令替换和脚本执行。
- Git reset/clean/checkout 等可能覆盖用户修改的命令。
- 环境变量或 glob 导致目标范围不确定的命令。

结果不是简单 true/false，而是 `allow/ask/deny + reasons`。

M1 的定位是建立统一、保守、可替换的最小防线，不把正则分析误认为完整的 Shell 安全解析。当前必须保证：分析器返回 `deny` 时最终不能降级为 `ask`，返回 `ask` 时最终不能被权限策略降级为 `allow`；包含管道、重定向、后台执行、动态展开或脚本调用的命令不能因为首个词看起来只读而自动放行。

### 4.4 工具执行前预览

增加事件：

```ts
type AgentEvent =
  | { type: "tool_preview"; preview: ToolExecutionPreview }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "approval_resolved"; result: ApprovalResult }
  | ExistingAgentEvent;
```

CLI 输出至少显示：

- 工具名。
- 完整命令或文件操作摘要。
- canonical cwd。
- 受影响路径。
- patch/edit diff。
- 风险原因。
- 此次批准、会话内批准或拒绝选项。

只读低风险工具可以配置为自动允许，但仍应生成内部 preview 和 audit event。

### 4.5 ApprovalBroker

接口：

```ts
interface ApprovalBroker {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult>;
}
```

提供两个实现：

- `CliApprovalBroker`：用于真实 CLI，默认拒绝，支持一次批准和本会话同规则批准。
- `StaticApprovalBroker`：用于测试，通过预设规则返回 allow/deny。

审批等待期间，文件和权限可能变化。因此批准后、执行前必须重新检查：

- canonical target。
- 文件 hash/mtime。
- 当前 permission profile。
- 当前 workspace roots。
- command assessment fingerprint。

任一变化都使旧审批失效并重新预览。

### 4.6 read-before-edit 升级

`FileStateCache` 改为保存：

```ts
interface FileSnapshot {
  canonicalPath: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
  fileId?: string;
}
```

从只检查 mtime 升级为 hash + metadata。写入采用：

```text
读取目标
-> 校验 snapshot
-> 写临时文件
-> fsync/close
-> 原子 rename
-> 记录 before/after hash
```

`edit_file` 的 preview 展示统一 diff；`write_file` 覆盖既有文件时也展示 diff，新文件展示完整创建摘要。

### 4.7 审计记录

M1 可以先使用 session 内存和 JSONL 临时 audit writer，正式 transcript 在 M5 接管。

每次记录：

- call id、tool name、原始/规范化输入摘要。
- workspace 和 canonical paths。
- decision 和 reasons。
- 谁批准、批准范围、批准时间。
- 执行前复检结果。
- success/error/aborted。
- 文件 before/after hash。

不得把 API key、完整环境变量和敏感文件内容写进审计日志。

### 4.8 M1 测试

必须包含：

- 文件路径直接越界。
- 工作区内 symlink 指向外部。
- 新文件父目录 symlink 指向外部。
- Windows 大小写和盘符。
- search 工具越界。
- shell `cd ..`。
- 删除命令触发 ask/deny。
- 只读工具自动允许。
- 写操作产生 preview。
- deny 后 runtime 从未执行。
- 审批后文件被修改，旧审批失效。
- bypass-immune 路径即使 approval allow 也拒绝。
- audit 不泄漏测试 secret。

### 4.9 M1 完成标准

- 任何工具执行前都存在 `ToolPreflightResult`。
- 所有文件工具使用同一个 `WorkspacePolicy`。
- 写工具和高风险命令可以暂停并等待审批。
- CLI 能展示预览。
- 审批后执行前会复检。
- 现有工具不能直接绕过 preflight 调用。
- M0 测试全部继续通过。

M1 不要求完成 Shell tokenizer、命令链 AST 或 OS sandbox；这些能力在 M3.5 实现。M1 的完成标准是现有静态分析、预览、审批、复检和审计链路行为一致且没有明显误放行。

## 5. M2：协议类型和模型事件

预计：3 到 5 个开发日。

目标：让核心循环能够表达真实 tool call，而不是要求模型把 action 包成自定义 JSON 文本。

### 5.1 拆分 `src/types.ts`

新增：

```text
src/protocol/
├── ids.ts
├── items.ts
├── model-events.ts
├── agent-events.ts
├── errors.ts
└── usage.ts
```

使用 branded id：

- `SessionId`
- `TurnId`
- `RequestId`
- `CallId`
- `HistoryOrdinal`

定义结构化 `ResponseItem`：

- user text。
- assistant text/reasoning。
- tool call。
- tool result。
- compact checkpoint。
- context injection。
- turn aborted。

### 5.2 错误分类

建立判别联合：

```ts
type AgentError =
  | { kind: "configuration"; recoverable: false; message: string }
  | { kind: "transport"; recoverable: true; retryAfterMs?: number }
  | { kind: "protocol"; recoverable: true; raw: string }
  | { kind: "tool_validation"; recoverable: true; callId: CallId }
  | { kind: "tool_runtime"; recoverable: true; callId: CallId }
  | { kind: "permission"; recoverable: true; callId: CallId }
  | { kind: "cancelled"; recoverable: false; reason: string };
```

不要继续通过中文错误字符串判断控制流。

### 5.3 ModelTransport

新接口只暴露流：

```ts
interface ModelTransport {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  capabilities(): ModelCapabilities;
}
```

事件必须包括：

- response started。
- text delta。
- tool call started/input delta/completed。
- usage。
- response completed。
- transport warning。

保留当前 `OpenAIChatModelClient` 作为兼容 adapter；`OutputParser` 只处理不支持 native tool call 的 provider。

### 5.4 M2 完成标准

- 核心协议不再依赖单个字符串 `Message`。
- FakeModel 能产生结构化 tool call 流。
- 兼容模型仍可走 JSON/ReAct parser。
- 任意 tool call 有稳定 call id。
- usage 与 request id 关联。
- M1 preflight 可以直接消费结构化 tool call。

## 6. M3：ToolRouter、Registry、Runtime 与并发

预计：4 到 6 个开发日。

目标：分离“模型能看到什么”和“系统真正能执行什么”。

### 6.1 ToolRuntime

把当前 `Tool` 拆为：

- `ToolSpec`：名称、描述、schema、exposure、parallel metadata。
- `ToolRuntime`：validate、preflight、execute、normalize output。
- `ToolRegistration`：spec + runtime + source + version。

新增 namespace 和 exposure：

- direct。
- deferred。
- internal。
- hidden。

### 6.2 运行时参数校验

引入成熟 JSON Schema validator，例如 Ajv。注册时编译 schema，执行前校验 input。

要求：

- 未知字段策略明确。
- 错误返回到模型时包含字段路径。
- schema 本身注册失败时启动失败。
- tool name/namespace 冲突直接报配置错误。

### 6.3 ToolRouter

职责：

1. 从模型事件建立 `ToolCall`。
2. 确认该工具在本次 `TurnContext` 中可见。
3. 查找注册 runtime。
4. 经过 M1 preflight/approval。
5. 调用 runtime。
6. 标准化结果并发出生命周期事件。

### 6.4 并发执行

不要继续使用轮询 + `setTimeout(5)`。

实现异步 read/write gate：

- 支持并行的只读工具共享。
- 写工具和未知工具独占。
- 同一路径写入增加 path mutex。
- 结果按提交顺序写回历史。
- 每个工具独立 AbortController。
- turn 取消会级联取消未完成工具。
- timeout 必须真正 abort runtime，而不只是让外层 Promise 提前 reject。

### 6.5 M3 完成标准

- `Executor` 不再直接 `registry.get().execute()`。
- model-visible specs 和 runtime registry 分离。
- schema validation、preflight、approval、runtime、postprocess 顺序固定。
- 多只读工具可并发，写工具串行。
- transcript 顺序不受完成先后影响。
- 旧 `StreamingToolExecutor` 删除或完全迁移。

## 6.6 M3 与 M3.5 的边界

M3 只负责把模型可见的工具 spec、工具路由和真正执行的 runtime 分离，并固定 preflight、审批、runtime、结果标准化的调用边界。M3 不负责把当前正则版 `CommandAnalyzer` 直接升级为完整 Shell 解析器。

M3 完成后，命令分析器必须通过稳定接口注入 runtime，使后续实现可以替换内部解析算法而不改动 Session 或工具协议。

## 6.7 M3.5：结构化 Shell 分析与运行时隔离

预计：6 到 10 个开发日。

目标：解决 M1 正则分析无法可靠理解多命令链、Shell 语法和运行时能力边界的问题。该阶段必须在 M3 runtime 分离完成后、M4 Session/Turn 状态机之前完成。

### 6.7.1 Shell tokenizer 与命令链 AST

执行顺序：

```text
原始命令
-> 按目标 Shell 进行词法切分
-> 识别引号、转义、变量、命令替换和控制操作符
-> 构建命令链 AST
-> 分析每个子命令
```

首版至少覆盖：

- 简单命令和参数边界。
- `;`、`&&`、`||`、`|`、`&` 命令链关系。
- 输入/输出/追加重定向。
- 子 Shell、子命令和脚本解释器调用。
- 变量展开、glob、命令替换等不确定目标。
- Windows `cmd`/PowerShell 与 Unix shell 的可替换 parser adapter。

不能使用简单的 `split(';')` 替代 tokenizer；分隔符可能位于引号、转义内容或脚本文本中。

### 6.7.2 子命令风险分析与合并

每个 AST 节点分别分析：

- 读、写、删除、覆盖和权限修改。
- 网络访问和依赖安装。
- 工作区外路径。
- 动态目标和脚本执行。
- 管道、重定向、后台任务和子进程。

整体风险采用保守合并：

```text
任意子命令 deny -> 整体 deny
没有 deny 但存在 ask -> 整体 ask
全部子命令 allow -> 才允许整体 allow
```

风险预览必须列出命令链、子命令、控制关系、受影响路径和每个风险原因，不能只显示首个命令词。

### 6.7.3 SandboxProvider

新增可替换接口：

```ts
interface SandboxProvider {
  capabilities(): SandboxCapabilities;
  execute(request: SandboxRequest): Promise<SandboxResult>;
}
```

runtime 执行顺序固定为：

```text
结构化命令分析
-> 权限决策与审批
-> sandbox capability 检查
-> 受限子进程执行
-> 资源和退出状态审计
```

Sandbox 至少表达文件系统、网络、子进程、工作目录、环境变量和超时限制。Windows 和 Unix 通过 adapter 接入平台能力，不在 TypeScript 中复制完整操作系统沙箱实现。

平台不支持所需隔离能力时，必须明确降级为 `ask` 或 `deny`，不得静默使用无限制 Shell。用户批准只表示接受展示的风险，不得绕过 sandbox 的硬限制。

### 6.7.4 M3.5 测试与完成标准

- 引号、转义和嵌套命令不会被错误拆分。
- 多命令链按每个子命令分析，最高风险正确合并。
- 只读命令加重定向、管道、后台符号或动态展开不会自动放行。
- 任意子命令 `deny` 时 runtime 不启动。
- parser 无法确定语义时保守进入 `ask`。
- sandbox capability 不满足时不会静默执行未隔离命令。
- sandbox 拒绝、超时、取消和子进程退出状态都有审计记录。
- M1 的审批后复检仍然在 sandbox 执行前生效。

M3.5 完成标志是：`CommandAnalyzer` 已由字符串正则筛选器升级为按 Shell adapter 解析的结构化分析器；工具调用在受限 runtime 中执行；没有 sandbox 能力时系统按策略明确降级；M0/M1 测试全部继续通过。

## 7. M4：在稳定安全执行模型上实现 Session 和 Turn 状态机

预计：5 到 7 个开发日。

目标：在 M1/M3/M3.5 的安全执行模型稳定后，取代当前大循环，让中断、恢复、待处理输入和多次 sampling request 成为一等状态。M4 不再重新定义命令风险或 sandbox 契约，只消费 M3.5 已固定的结构化安全结果。

### 7.1 SessionCoordinator

负责：

- 一个 session 最多一个 active turn。
- input queue。
- turn start/stop。
- budget。
- cancellation tree。
- session-level services。
- event dispatch。

状态：

```text
created -> ready -> running -> waiting_approval -> closing -> closed
```

### 7.2 TurnRunner

状态：

```text
created
-> preflight_context
-> precompact
-> sampling
-> dispatching_tools
-> awaiting_followup
-> compacting
-> completed | aborted | failed
```

一次 turn 可以包含多次模型采样。工具调用不代表 turn 结束，工具结果应驱动下一次 sampling。

### 7.3 InputQueue

支持：

- 新用户输入。
- steer。
- interrupt。
- approval result。
- manual compact。
- shutdown。

规定优先级：

1. shutdown/interrupt。
2. approval result。
3. steer/user input。
4. background notifications。

### 7.4 ContinueReason 真正接线

每次继续必须记录：

- tool result。
- pending user input。
- parse retry。
- transport retry/fallback。
- context compacted。
- stop hook continue。
- recoverable tool error。

删除没有实际生产或消费的枚举值。

### 7.5 移除双主循环

达到行为等价后：

- 删除 `src/core/agent.ts`。
- `AgentSession` 变为兼容 facade，内部调用 `SessionCoordinator`。
- `src/index.ts` 只做依赖组装和 CLI 呈现。

### 7.6 M4 完成标准

- 并发调用 `run` 不会产生两个 active turn。
- interrupt 能取消模型请求和工具。
- approval 等待不会占用忙轮询。
- pending input 在正确采样边界写入。
- 每个结束路径有明确 terminal reason。
- FakeModel 多工具、多 sampling request 场景通过。

## 8. M5：Transcript、Resume 和 Fork

预计：5 到 8 个开发日。

目标：使进程崩溃或用户退出后可以继续，而不是只保留内存数组。

### 8.1 JSONL 唯一真源

新增：

```text
src/persistence/
├── rollout-writer.ts
├── rollout-reader.ts
├── rollout-schema.ts
├── reconstruction.ts
└── session-index.ts
```

每行包含：

- schema version。
- ordinal。
- timestamp。
- session/turn id。
- item kind。
- payload。
- parent/fork lineage。

使用单写者队列，禁止多个模块直接写文件。

### 8.2 最小事件集

- session meta。
- turn started/completed/aborted。
- user/assistant item。
- tool call/result。
- preview/approval/audit。
- context injection。
- compact checkpoint。
- task event。
- hook event。
- rollback/fork reference。

### 8.3 崩溃恢复

Reader 必须处理：

- 最后一行部分写入。
- 未完成 turn。
- 已发起但没有结果的工具。
- 等待中的 approval。
- 重复 ordinal。
- schema 版本迁移。

恢复策略必须保守：不自动重放可能有副作用的工具。未确认执行结果的写工具标记为 `unknown_outcome`，要求用户检查。

### 8.4 Session index

M5 先使用可重建的 JSON index 或内存扫描；不要立刻引入 SQLite 复杂度。数据量和查询需求明确后，在 M10 添加 SQLite。

### 8.5 M5 完成标准

- 结束后可通过 session id resume。
- 崩溃在模型流、工具执行、approval 三个位置均有测试。
- resume 后不会重复执行写工具。
- fork 保留父 session id 和历史边界。
- 删除索引后可从 JSONL 重建。

## 9. M6：上下文 checkpoint 与压缩

预计：4 到 6 个开发日。

目标：把当前内存文本压缩升级为可恢复的 context window 管理。

### 9.1 先修当前已知问题

- system prompt、tool specs、AGENTS、skills 计入预算。
- 非流式 fallback 也返回 usage 或明确估算。
- `restoreRecentFiles` 不再重复追加 system message。
- 删除 `PromptBuilder.truncateHistory` 与 `CompactionPipeline` 双重截断。
- tool result spill 在结果进入 history 时执行，不等待下一轮 compact。

### 9.2 ContextManager

`TranscriptStore` 保存完整历史；`ContextManager.forPrompt()` 生成投影。

压缩等级：

1. 大结果 spill。
2. 清理旧 tool body，保留引用。
3. 投影旧 turn。
4. 模型摘要。
5. window rollover/checkpoint。

### 9.3 Checkpoint

每次压缩写入：

- before/after token estimate。
- summary。
- replacement history。
- window id。
- 最近文件和任务状态。
- 当前 world state fingerprint。
- compaction reason 和 phase。

Resume 直接重放 checkpoint，不再次调用模型摘要。

### 9.4 M6 完成标准

- pre-turn、mid-turn 和 manual compact 都有测试。
- 压缩后任务、用户约束和最近文件仍存在。
- resume 后 prompt 投影与压缩后等价。
- token 预算不会只计算 history。
- 超限时不会无限 compact 循环。

## 10. M7：配置、AGENTS.md、CLAUDE.md 与 Skills

预计：4 到 6 个开发日。

目标：让配置有来源、有约束、可解释。

### 10.1 配置层

按以下优先级：

```text
packaged defaults
< system/managed requirements
< user
< project
< local env
< session flags
< CLI overrides
```

每个字段保留来源 provenance。修复当前 local 默认值覆盖 user/project 的问题：local 层只包含用户实际设置的字段，不能重新注入完整默认配置。

### 10.2 严格配置校验

建议使用成熟 TOML parser，不继续扩展手写子集解析器。配置加载后做 runtime schema 校验：

- 未知字段。
- 错误类型。
- 数值范围。
- 路径有效性。
- managed constraint 冲突。
- secret 不进入日志。

### 10.3 AGENTS / CLAUDE

- project root 到 cwd 分层发现。
- provenance。
- UTF-8 安全截断。
- 候选文件配置。
- nested cwd 规则。
- 多 workspace 环境标签。
- 项目指令不能提升自身权限。

### 10.4 Skills

首版只做本地 `SKILL.md`：

- frontmatter 校验。
- name/description。
- 显式提及触发。
- 内容预算。
- supporting file 相对路径。
- 不允许 skill 绕过 approval 和 workspace policy。

### 10.5 M7 完成标准

- `config explain` 能显示字段最终值和来源。
- 用户未设置的 env 字段不会覆盖项目配置。
- nested AGENTS 作用域测试通过。
- 无效 skill 不会破坏 session 启动。
- skill 注入计入 token budget。

## 11. M8：任务图和多 Agent

预计：7 到 10 个开发日。

前置条件：M5 resume 和 M6 checkpoint 已完成。

### 11.1 任务图

用图替换当前栈：

- pending。
- blocked。
- in_progress。
- completed。
- failed。
- retrying。
- cancelled。

字段：

- parent。
- owner session。
- blocks/blockedBy。
- acceptance criteria。
- attempts。
- budget。
- result summary。
- timestamps。

提供 `task_create/get/list/update` 工具。

### 11.2 Scheduler

- 只调度依赖已满足的 ready task。
- 防止同一任务重复领取。
- 支持失败重试上限。
- 支持取消传播。
- 公平处理多个 ready task。

### 11.3 子 Agent

第一版仅实现本地 fork：

- 独立 session id 和 transcript。
- 继承只读上下文前缀。
- 独立 token/tool budget。
- 通过持久 mailbox 通信。
- 父 Agent 只接收结构化结果摘要。
- 子 Agent 不能直接修改父 Agent 内存。

第二版再实现 worktree 隔离和异步 Agent。

### 11.4 M8 完成标准

- 依赖任务不会提前执行。
- 子 Agent 崩溃可恢复或明确失败。
- 父子 transcript 可追踪。
- 取消父任务会传播。
- 并行 Agent 的写入冲突可检测。
- 没有共享可变 `workingMemory`。

## 12. M9：Hooks、MCP 和插件

预计：8 到 12 个开发日。

### 12.1 Hooks

事件：

- SessionStart/End。
- UserPromptSubmit。
- PreToolUse/PostToolUse。
- PermissionRequest。
- PreCompact/PostCompact。
- Stop/Interrupt。
- SubagentStart/Stop。

实现 preview/run 两阶段。Hook 有：

- matcher。
- handler type。
- timeout。
- trust hash。
- continue/abort policy。
- input rewrite 或 additional context。

### 12.2 MCP

先实现 stdio transport，再实现 HTTP/SSE。连接状态：

```text
disconnected -> connecting -> ready -> degraded -> closed
```

要求：

- MCP tool 进入 M3 spec plan。
- MCP runtime 仍经过 M1 preflight/approval。
- server 故障只禁用对应工具。
- tool name namespace 冲突可检测。
- 连接和调用都有 timeout/cancel。

### 12.3 插件

插件只做声明式组合：

- manifest。
- tools。
- skills。
- hooks。
- MCP servers。
- required permissions。
- content hash/trust。

不要允许插件直接修改 SessionCoordinator 内部状态。

### 12.4 M9 完成标准

- Hook 可以 block、rewrite、continue。
- Hook 超时策略明确。
- MCP 断线不会终止整个 session。
- 插件权限在启用前可预览。
- 所有扩展调用可审计。

## 13. M10：记忆、可观测性和 App Server

预计：持续演进，首版 8 到 12 个开发日。

### 13.1 记忆

- SQLite 作为结构化 memory source of truth。
- user/feedback/project/reference 四类。
- extraction 和 consolidation 分离。
- provenance、confidence、updatedAt、delete。
- 默认 lexical retrieval，后续再加入 embedding。
- MEMORY.md 只是派生索引。

### 13.2 可观测性

关联 id：

- sessionId。
- turnId。
- requestId。
- callId。
- promptId。

指标：

- TTFT、provider latency、retry。
- token/cost/cache。
- tool queue/wait/execute。
- approval 和 deny。
- compact before/after。
- task/agent success。
- sandbox violation。

### 13.3 App Server

在 CLI 稳定后提供 JSON-RPC：

- session create/resume/fork。
- turn start/interrupt。
- event stream。
- approval request/result。
- transcript query。
- tool/skill/MCP status。

前端只能通过协议控制核心，不得 import session 内部类。

## 14. 推荐的 PR/提交拆分

每个 PR 只建立一个不变量，建议顺序：

1. 测试框架和现有行为回归。
2. WorkspacePolicy 和 canonical path。
3. Tool preflight 与 preview 类型。
4. ApprovalBroker、CLI 确认和复检。
5. File snapshot hash、原子写和 diff preview。
6. Protocol ids/items/errors。
7. ModelTransport 和 native tool call events。
8. ToolSpec/Runtime/Registry。
9. ToolRouter 和 schema validation。
10. 并发 gate、ordered results 和 cancellation。
11. SessionCoordinator/InputQueue。
12. TurnRunner 状态机并删除旧主循环。
13. RolloutWriter/Reader。
14. Resume/reconstruction/fork。
15. ContextManager/checkpoint。
16. 配置 provenance 和 AGENTS 修复。
17. Task graph。
18. 本地子 Agent。
19. Hooks。
20. MCP stdio。
21. Skills/plugins。
22. Memory/metrics/App Server。

若一个 PR 同时触碰安全策略、主循环、持久化和 UI，说明范围过大，应继续拆分。

## 15. 前十个开发日的具体安排

### 第 1 天

- 确认或初始化 Git。
- 补齐 `.gitignore`。
- 建立 `tests/unit`、`tests/integration`。
- 添加 `npm test` 和 `npm run check`。
- 写 OutputParser、token estimator 测试。

### 第 2 天

- 写 file state、edit、path、compaction 测试。
- 写 FakeModel 端到端测试。
- 修复测试暴露的现有问题，但不改协议。
- 提交 M0。

### 第 3 天

- 定义 `WorkspacePolicy`。
- 实现 canonical root、existing target realpath。
- 实现 new target parent realpath。
- 覆盖 Windows 路径测试。

### 第 4 天

- 把 read/write/edit/list/search 全部迁移到 WorkspacePolicy。
- 增加 symlink 穿透测试。
- 敏感路径改为 canonical path 匹配。

### 第 5 天

- 定义 ToolPreflightResult 和 ToolExecutionPreview。
- 为每个现有工具实现 preview builder。
- 加入 `tool_preview` 事件。
- 确保 runtime 尚未执行时就能得到 preview。

### 第 6 天

- 定义 permission profile 和 allow/ask/deny。
- 实现 StaticApprovalBroker。
- 编写 deny 不执行、allow 执行的集成测试。

### 第 7 天

- 实现 CliApprovalBroker。
- 写一次批准、会话批准、拒绝。
- 默认行为设为保守模式。
- 日志做 secret redaction。

### 第 8 天

- 升级 FileStateCache 为 content hash snapshot。
- 写 approval 后文件变化的复检测试。
- 开始原子文件写入。

### 第 9 天

- 实现 edit/write diff preview。
- 加入 before/after hash audit。
- 修复 shell cwd 越界。
- 建立最小 CommandAnalyzer。

### 第 10 天

- 跑完整 `npm run check`。
- 手工演示 read 自动允许、write 询问、危险路径拒绝。
- 整理 M1 文档和决策记录。
- 提交 M1，再开始协议重构。

## 16. 每个里程碑的统一完成定义

任何里程碑只有同时满足以下条件才算完成：

- TypeScript strict 无错误。
- build 通过。
- 单元和集成测试通过。
- 有至少一个故障路径测试。
- 新增公共类型有明确所有者和注释。
- 资源可释放：进程、流、文件句柄、timer、AbortController。
- 错误有结构化 kind，不靠字符串匹配控制流。
- 安全相关 decision 有审计。
- README 或对应设计文档已更新。
- 没有遗留“已创建但未接通”的核心对象。
- 没有为了通过测试而放宽工作区或审批规则。

## 17. 当前阶段不要做的事情

在 M0 到 M5 完成前，暂缓：

- 完整 UI/TUI。
- 云端 Agent。
- 大规模插件市场。
- embedding 向量库。
- 复杂多 Agent 协作。
- 跨机器远程 sandbox。
- 为追求源码相似而照搬 Codex 的所有 Rust crate。
- 为 Claude Code 未公开实现设计未经验证的内部类。

当前最重要的是建立五个不变量：

1. 工具执行前一定经过预检。
2. 高风险操作一定能预览和审批。
3. 文件工具一定不能越过真实工作区。
4. 每个 turn 和工具调用都可取消、可追踪。
5. 每个 session 都可从 transcript 恢复。

## 18. 最终验收场景

当 v2 核心完成时，应能通过以下完整场景：

1. 用户要求修改一个 TypeScript 文件。
2. Agent 搜索并读取目标文件。
3. 只读工具自动通过，但产生 audit。
4. Agent 生成 edit 或 patch。
5. CLI 在执行前展示 diff、canonical path 和风险。
6. 用户批准。
7. 系统复检文件 hash 和权限。
8. 写操作在工作区策略和 sandbox 下执行。
9. Agent 运行 typecheck/build/tests。
10. 工具结果过大时落盘并只注入预览。
11. context 超限时写入 checkpoint 并继续。
12. 进程中断后通过 session id resume。
13. 恢复时不会重复执行已完成或结果不确定的写操作。
14. 最终答案引用实际验证结果。
15. transcript 能回答每个文件是谁、何时、基于哪个版本修改的。

达到这些条件后，项目才从“可演示 Agent”进入“可靠 SWE Agent 内核”阶段。
