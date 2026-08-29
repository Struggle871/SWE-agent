# Project Memory (AGENTS.md)

## 项目定位

- 本项目是 `minimal-swe-agent`，使用 TypeScript 编写的单 Agent SWE Agent 原型。
- TypeScript 必须保持 `strict` 模式；新增代码优先使用现有类型、模块边界和错误处理模式。
- 当前完成范围是 Phase 1/2 原型、Phase 3 M0 和 M1。M2 及以后的设计只代表规划，不得在文档、日志或代码注释中写成已实现。

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
- 新增工具必须声明参数 schema、描述和 `isReadOnly` 属性，并注册到 `src/index.ts` 的 `ToolRegistry`。
- 新增权限风险时同步更新 `ToolRisk`、`PermissionPolicy`、预览字段、审计字段和测试。
- 修改持久化、上下文压缩或会话循环时，要覆盖恢复、超时、取消和错误路径；不要只测试成功路径。
- 不要把 M2+ 的 ToolRouter、原生模型事件、Transcript/Resume/Fork、Hooks、Skills、MCP 或多 Agent 目录提前作为空壳实现，除非对应里程碑已经开始并有测试契约。
- 不要提交 `node_modules/`、`dist/`、`.env`、`.swe-agent/`、`tmp/`、测试产物或外部源码研究材料。

## 文档维护

- README 必须反映当前实际可运行能力、验证结果和未完成边界。
- 阶段实现状态以源码和测试为准；路线图用于计划，不覆盖实际验证结果。
- 变更工具安全链路后，更新 `README.md` 与相关 `docs/` 记录，说明新增不变量和测试覆盖。
