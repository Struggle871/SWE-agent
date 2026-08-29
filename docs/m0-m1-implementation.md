# M0 与 M1 实现说明

更新时间：2026-08-27

## 1. 当前结论

M0 工程基线与 M1 工具安全阶段已经接入当前主执行链。`AgentSession -> runTurn -> Executor -> Tool` 中，每次已注册工具调用都必须经过统一 preflight。新增模块不是旁路设计，CLI、FakeModel 端到端执行和现有文件、搜索、终端工具都使用同一条路径。

本阶段建立以下不变量：

1. 工具 runtime 执行前一定产生 `ToolPreflightResult`。
2. 文件路径按真实路径而不是字符串前缀判断工作区边界。
3. 写操作和高风险命令可以在执行前预览并暂停审批。
4. 批准后会重新计算路径、文件 hash、权限、命令风险和 workspace roots 指纹。
5. 文件写入需要最新 read snapshot，并使用原子替换。
6. allow、ask、deny、复检和执行结果都有脱敏审计记录。

## 2. M0 工程基线

项目已初始化 Git 元数据，`.gitignore` 排除了依赖、构建、测试构建、审计、coverage、临时源码和日志。没有自动创建提交，当前工作树仍由项目所有者决定如何组织首次提交。

测试工具链使用 TypeScript 编译器和 Node 内置 `node:test`：

```text
npm test
npm run test:unit
npm run test:integration
npm run check
```

不再使用 `tsx --test`，从而规避当前 Windows 环境中的 `uv_os_get_passwd ENOMEM`。测试覆盖 JSON/ReAct 解析、未知工具、token 估算、配置与 AGENTS 发现、compaction 大结果落盘、文件快照、编辑歧义、read-before-edit、解析重试、FakeModel 端到端和 shell timeout 恢复。

## 3. M1 执行管线

统一顺序如下：

```text
ToolRegistry lookup
-> schema validate/default normalize
-> workspace/command preflight
-> preview + permission decision
-> audit preflight
-> approval when decision=ask
-> complete revalidation
-> runtime execute
-> before/after hash audit
```

任何阶段失败都返回 `ToolResult.isError=true`，且 runtime 不会在 deny 或审批拒绝后执行。`tool_preview`、`approval_requested` 和 `approval_resolved` 已加入事件流，CLI 会在输入批准前打印命令、canonical cwd、路径、风险原因和写入 diff。

## 4. WorkspacePolicy

`WorkspacePolicy` 支持 readable roots 与 writable roots。默认二者都是项目根目录，接口已支持多 root。

校验规则：

- workspace root 启动时通过 `realpath` 规范化。
- 已存在目标通过自身 `realpath` 校验。
- 新目标向上找到最近存在父目录，通过父目录 `realpath` 后重建目标路径。
- Windows 比较忽略盘符和路径大小写。
- 拒绝 NTFS alternate data stream。
- 工作区内 symlink/junction 指向外部时拒绝。
- `.git`、`.swe-agent`、`.claude`、`.codex` 与敏感文件属于 bypass-immune write path。
- read、write、edit、list、search 都重复使用相同策略。

目录遍历不会跟随 symlink。起始搜索目录如果通过 symlink 指向外部，会在遍历前被拒绝。

## 5. Preview 与审批

`ToolExecutionPreview` 包含 call id、工具、摘要、risk、cwd、受影响路径、命令、diff 和原因。只读工具默认 allow；write、execute、network 和 destructive 默认 ask；明确越界或严重破坏命令 deny。

实现了两个 broker：

- `CliApprovalBroker`：支持本次批准、当前会话同类批准和拒绝；非 TTY 默认拒绝。
- `StaticApprovalBroker`：用于测试和嵌入场景，可以返回固定或动态决策。

批准只对当前 permission fingerprint 有效。审批期间文件内容、canonical target、workspace roots、权限 profile 或 command assessment 变化后，旧批准失效，用户必须重新发起工具调用。

## 6. 文件一致性

`FileStateCache` 保存 canonical path、SHA-256 content hash、size、mtime 和文件 id。hash 是最终一致性判据，mtime 相同但内容变化也会被识别。

`write_file` 和 `edit_file` 的写入步骤：

```text
validate latest snapshot
-> calculate preview/diff
-> approval and revalidation
-> write same-directory temporary file
-> fsync and close
-> atomic rename
-> refresh snapshot
-> audit before/after hash
```

追加写也先构建完整新内容，再走原子替换，不使用无法回滚的直接 append。

## 7. 命令策略边界

首版 `CommandAnalyzer` 识别目录变化、工作区外绝对路径、`..`、管道、重定向、后台符号、删除/覆盖/权限修改、Git 工作树重写、网络和包安装、动态展开、`Invoke-Expression` 及子 shell。

该模块只负责执行前分类，不是 OS sandbox。高风险但可解释的命令可以由用户批准；严重系统破坏和明确 cwd 越界直接 deny。后续若要求即使批准也不能访问系统路径，需要新增真正的进程 sandbox，而不是继续堆叠正则。

## 8. 审计与脱敏

CLI 默认将 JSONL 写到 `.swe-agent/audit.jsonl`。内存 `AuditTrail` 可用于测试或嵌入。

审计记录 call id、工具、阶段、decision、路径、原因、批准主体/范围/时间、复检结果、执行状态和 before/after hash。以下内容不会原样记录：

- `content`、`old_string`、`new_string`、`diff` 和 body。
- API key、token、password、authorization、cookie 等命名字段。
- Bearer token、常见 `sk-*` token 和命令中的 secret 环境变量赋值。

## 9. 验收命令

```powershell
npm run check
$env:USE_FAKE_MODEL = "true"
node dist/index.js "请查看当前目录结构，然后给出最终结论"
```

开始 M2 前应保持 `npm run check` 为绿色。M2 可以直接消费现有结构化 preflight、preview 和 approval 类型，不应重新建立第二套权限入口。
