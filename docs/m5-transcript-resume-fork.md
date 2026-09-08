# M5 存储分期设计：Transcript、Resume、Fork

> 状态：M5 已实现；本文同时记录 Codex 存储系统中已落地的核心不变量与明确延期的能力。

## 1. M5 目标

M5 解决一个问题：session 不再依赖进程内 `Message[]`，进程退出、崩溃或用户重新启动后，仍能从 canonical transcript 恢复到可继续状态。

对齐 Codex 的是存储不变量，而不是复制所有 Rust crate：

```text
SessionCoordinator
  -> single writer
  -> append-only JSONL (canonical)
  -> reconstruction
  -> Resume / copied Fork
  -> rebuildable lightweight index
```

## 2. M5 必须实现

### 2.1 Canonical Transcript

每个 session 一个 append-only JSONL 文件。每行使用版本化 envelope，至少包含：

- `schemaVersion`、`ordinal`、`timestamp`。
- `sessionId`、可选 `turnId`/`stepId`/`callId`。
- `kind`、结构化 payload、可选 parent/fork lineage。

M5 的 canonical kind 包括 session meta、turn started/completed/aborted、user/assistant item、tool call/result、preview、approval、audit、context injection 和 interruption marker。`task`、`hook`、`compact` 等只注册 schema，不实现其生产者。

仅用于界面刷新的 text delta、typing 状态和临时进度属于 transient event，不写入 canonical transcript。所有 canonical append 必须经过唯一 writer。

### 2.2 Writer 生命周期

`TranscriptStore`/`RolloutWriter` 至少提供：

```text
open(sessionId)
append(item)
flush()
shutdown()
```

writer 负责顺序 ordinal、追加失败重试、关闭前 flush 和幂等检查。M5 只保证单进程单 writer；不提供跨进程锁。

### 2.3 Reader 与恢复分类

Reader 必须区分：

- 文件末尾的部分行：截断到最后一个完整换行。
- 完整但无法解析的行：报告损坏，不静默跳过。
- 重复或倒退 ordinal：报告协议错误。
- 未完成 turn、等待中的 approval、只有 tool call 没有 result 的调用。

未确认是否已经产生副作用的工具调用恢复为 `unknown_outcome`。Resume 不得自动重放写入、删除、网络或其他可能有副作用的工具；用户确认后才可显式继续。

### 2.4 Session Resume

恢复入口以 `sessionId` 为主，路径为诊断和迁移辅助。reconstruction 从 canonical items 重建：

- 当前 session/turn 状态。
- provider 可消费的 history projection。
- pending approval/input 的明确状态。
- 已完成 tool call 集合，避免重复执行。
- 当前有效 instructions 的重新注入点。

恢复后重新生成 prompt projection，不把旧 prompt 当作真相。连续多次 `run` 必须追加到同一 session transcript。

### 2.5 Copied Fork

M5 实现 copied fork：复制父 session 指定 ordinal 边界之前的 canonical items 到新的 session 文件，并写入 `parentSessionId`、`forkedAtOrdinal` 和 fork 原因。父 session 保持不可变，子 session 使用自己的 ordinal 空间。

reference/paginated fork 暂不实现，避免在 lineage、分页和 materialization 尚未稳定时引入隐式共享历史。

### 2.6 轻量索引

M5 可维护 JSON index 或按目录扫描得到 session 列表、最近更新时间、标题和 transcript 路径。索引始终是派生数据：删除后必须从 JSONL 完整重建，Resume 不依赖索引存在。

## 3. 明确延期能力

| Codex 能力 | 计划阶段 | 记录 |
|---|---|---|
| reference/paginated fork、`history_base`、byte/ordinal checkpoint | M8-M10 | 大历史优化；M5 仅 copied fork |
| SQLite session/task/file/搜索 projection | M10 | 查询优化，不是真源 |
| archive/unarchive/delete/revert、源 rollout 删除保护 | M9-M10 | 需要引用保护和 destructive audit |
| 跨进程 writer lock、lifecycle reservation、stale writer 清理 | M8-M10 | M5 单进程假设 |
| queue、approval/input mailbox 持久化 | M8-M9 | 依赖任务图、hooks/MCP、多 agent |
| rollout compression/materialization/reverse scanner/migration | M6-M10 | 依赖 checkpoint 和 schema migration |
| L3 trace、cost/token/span、trace retention policy | M10 | 与可观测性统一设计 |
| stale index/lineage repair、引用计数 | M9-M10 | 依赖完整 projection 和 fork 引用语义 |

## 4. M5 验收与测试契约

- 连续两次以上 `run` 共享同一 session transcript。
- 模型流、工具执行、approval 等位置发生崩溃后，Reader 能恢复并分类状态。
- partial tail 可修复；完整坏行、重复 ordinal 被拒绝并可诊断。
- Resume 不重复执行已经完成的写工具；不确定结果进入 `unknown_outcome`。
- copied fork 保留父 ID 和边界，父文件内容不变。
- 删除 JSON index 后可从 JSONL 重建并完成 Resume。
- transient UI/model delta 不进入 canonical transcript。

每个场景都使用临时目录；不得写入项目 `.swe-agent/`、`tmp/` 或用户目录。

## 5. 与后续阶段的接口约束

后续阶段可以在不破坏 M5 的前提下增加新的 `kind`、projection 和 fork strategy，但必须遵守：

1. JSONL 是唯一 canonical source。
2. SQLite、trace、JSON index 都是可删除的派生物。
3. 新的 side effect 必须拥有明确的 started/completed/unknown outcome 状态。
4. reference fork 不能改变 copied fork 的父历史不可变语义。
