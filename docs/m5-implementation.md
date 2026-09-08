# M5 实现记录：Transcript、Resume、Fork

## 1. 已实现范围

M5 已在 M4 session/turn 主链上接入持久化，不改变现有工具安全链路：

- `src/persistence/rollout-schema.ts`：版本化 JSONL envelope、canonical kind 和 payload 类型。
- `src/persistence/rollout-writer.ts`：单进程单 session writer、顺序 ordinal、追加重试、flush/shutdown 和重复 writer 保护。
- `src/persistence/rollout-reader.ts`：JSONL 读取、partial tail 修复、完整坏行/版本/ordinal 校验。
- `src/persistence/reconstruction.ts`：从 transcript 重建 history、活动 turn、pending approval 和未确认工具调用。
- `src/persistence/transcript-store.ts`：创建、恢复和 copied fork。
- `src/persistence/session-index.ts`：可删除并从 JSONL 重建的轻量 session index。
- `SessionCoordinator`：session 级 history 所有权；连续多次 `run` 共享同一 transcript；writer 在 session 结束时 flush。
- `AgentSession.resume()` / `AgentSession.fork()`：程序化 Resume/Fork API。
- CLI：支持 `--resume <sessionId>`、`--fork <sessionId>` 和 `--at <ordinal>`。

## 2. 恢复语义

- canonical message、tool call/result、approval、turn 生命周期进入 JSONL。
- model event、text delta、typing/progress 等 transient event 不进入 canonical transcript。
- 只有 tool call 没有 result 时，恢复状态包含 `unknownOutcomes`；不会自动重放可能有副作用的工具。
- Resume 会追加 interruption marker 和 system warning，并重新生成 prompt projection。
- copied fork 将父历史复制到新文件，记录 `parentSessionId`、`forkedAtOrdinal` 和 `inheritedFrom`；父文件保持不变。

## 3. 尚未实现

以下能力仍是后续阶段，不应从当前代码推断为已完成：

- reference/paginated fork 和 `history_base`。
- SQLite projection、归档/删除/回滚和引用保护。
- 跨进程 writer lock、lifecycle reservation、stale writer repair。
- queue/approval/input mailbox 持久化。
- context checkpoint/materialization、rollout migration/reverse scanner。
- L3 trace、cost/token/span metrics。

## 4. 验证

新增测试覆盖：

- 多次 run 共用一个 session transcript。
- Resume 后历史连续且不重复 session meta。
- copied fork 的父 ID、边界和父文件不可变性。
- partial tail 修复。
- 完整坏行和重复 ordinal 拒绝。
- 未完成 side effect 标记为 `unknown_outcome`。
- 删除 index 后从 JSONL 重建。

当前检查：`npm run typecheck`、`npm test`（54/54）和 `npm run build` 均通过。
