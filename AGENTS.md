# Project Memory (AGENTS.md)

## 项目定位

- 本项目是 `minimal-swe-agent`，使用 TypeScript 编写，主要用于求职、技术面试和工程能力展示；目标是形成可运行、可验证、可解释的单 Agent SWE Agent 工程，不是 Demo、教程示例或只展示架构的原型。
- 开发优先级是“真实功能闭环 > 可验证的正确性 > 清晰的架构 > 未来扩展性”。不得为了贴近 Codex 的目录、类型或接口而复制框架；只有在当前功能确实需要且已有真实调用方时才增加抽象。
- “实现完成”必须意味着功能有真实用户入口、核心算法或协议行为、运行时依赖装配、成功与失败路径、持久化或生命周期处理（如适用），以及能够证明这些行为的单元/集成测试。
- 仅新增 interface、provider contract、adapter、空壳类、配置字段、mock transport、注释或文档，不算实现了对应功能；必须明确标记为基础设施、扩展点或未完成能力。
- 不能默认采用最小实现。需求指向完整功能时，应先定义端到端验收流程并实现主要使用路径、边界条件、错误恢复和可观察性；确因外部服务、凭据或平台能力无法完成时，必须清楚说明缺失的真实环节，不能用 fallback 或 FakeModel 代替并声称完成。
- 借鉴 Codex 或其他成熟项目时，必须解释该设计解决的本项目实际问题；如果现有结构已能满足需求，不因上游采用某种架构就机械照搬。
- TypeScript 必须保持 `strict` 模式；新增代码优先使用现有类型、模块边界和错误处理模式。
- 阶段状态必须以源码、公开入口和测试为准：当前 M0-M8 已完成验收；M9 的 Hooks、Plugin、动态 MCP、OAuth/PKCE 和 elicitation 主路径已完成，独立 MCP 管理 CLI、OAuth discovery/多进程刷新锁仍是后续增强；M10 的 Memory、App Server 和首版 Observability 已完成，成本与沙箱违规指标已接入，跨节点认证与更完整指标保留为后续硬化。不得把“部分完成”改写成整个里程碑完成。

## 验证要求

- 提交或交付前必须通过 `npm run typecheck`、`npm test` 和 `npm run build`；快捷命令是 `npm run check`。
- 新增或修改安全、工具执行、会话循环、上下文压缩行为时，必须同时增加或更新单元/集成测试。
- 测试必须使用临时目录，不能污染项目工作区、`.swe-agent/` 或用户文件。
- FakeModel 只能证明协议和执行链路的测试行为，不能替代真实模型流式、usage、重试或并发验证。

## 架构入口

- `src/index.ts` 负责配置加载、依赖组装、工具注册和 CLI 展示，不承载工具安全规则。
- `src/core/agent-session.ts` 负责会话级任务规划、历史、压缩和 turn 编排；`src/core/turn.ts` 负责单轮推进。
- `src/core/executor.ts` 是当前工具执行的唯一统一入口。
- `src/tools/registry.ts` 管理工具注册；新增工具必须在 `src/tools/` 实现并通过 `ToolRegistry` 注册。
- `src/security/` 负责工作区策略、命令分析、权限决策、审批和审计；不要在单个工具中复制这些规则。

## 工具安全不变量

所有工具调用必须保持以下顺序：参数校验与规范化、工作区/路径 preflight、命令风险分析、preview、allow/ask/deny、审批、执行前复检、runtime 执行、执行前后状态审计。

- 文件工具必须通过同一个 `WorkspacePolicy`；不能使用绕过 canonical path 校验的路径拼接。
- 搜索和终端工具同样受工作区边界约束；路径前缀检查不能替代真实路径和符号链接校验。
- 写入既有文件必须满足 read-before-edit，并使用 `FileStateCache` 的 snapshot/hash 检查外部变化。
- 写操作和高风险命令不得绕过 `ToolPreflight`、`PermissionPolicy` 或 `ApprovalBroker`。
- 审批后的目标路径、文件状态、权限配置或命令风险发生变化时，旧审批必须失效并拒绝继续执行。
- `.git`、`.swe-agent`、`.claude`、`.codex`、`.env` 等 bypass-immune 路径即使 approval 返回 allow 也必须拒绝普通写入。
- 只读工具可以自动允许，但仍必须生成 preview 和 audit 记录。
- 审计记录不得包含 API key、完整环境变量、凭据或完整文件内容；使用现有脱敏逻辑。
- 路径策略和命令分析不是 OS sandbox；不要宣称它们能够约束任意 shell 子进程。

## 变更规则

- 优先小步修改，保持现有 CLI 和 FakeModel 演示可运行。
- 开始较大功能前先写出可执行的端到端路径和完成标准；实现后从公开入口验证整条路径，不能只测试内部类或孤立 adapter。
- 测试替身只用于制造确定条件。涉及真实协议、模型 usage/streaming、MCP、Marketplace、安装器、文件监听、tokenizer 或沙箱能力时，必须区分 contract test、集成测试和真实环境验证，不得相互替代。
- 新增工具必须声明参数 schema、描述和 `isReadOnly` 属性，并注册到 `src/index.ts` 的 `ToolRegistry`。
- 新增权限风险时同步更新 `ToolRisk`、`PermissionPolicy`、预览字段、审计字段和测试。
- 修改持久化、上下文压缩或会话循环时，要覆盖恢复、超时、取消和错误路径；不要只测试成功路径。
- 不要把 M2+ 的 ToolRouter、原生模型事件、Transcript/Resume/Fork、Hooks、Skills、MCP 或多 Agent 目录提前作为空壳实现，除非对应里程碑已经开始并有测试契约。
- 不要提交 `node_modules/`、`dist/`、`.env`、`.swe-agent/`、`tmp/`、测试产物或外部源码研究材料。

## 文档维护

- README 必须反映当前实际可运行能力、验证结果和未完成边界。
- 阶段实现状态以源码和测试为准；路线图用于计划，不覆盖实际验证结果。
- 变更工具安全链路后，更新 `README.md` 与相关 `docs/` 记录，说明新增不变量和测试覆盖。
