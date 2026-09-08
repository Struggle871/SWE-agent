# M4 实现记录：Session / Turn 状态机与取消

## 1. 完成范围

M4 已接入当前 `AgentSession -> SessionCoordinator -> TurnRunner -> Executor` 主链。M4 只负责 session/turn 生命周期、输入边界和取消传播，不提前实现 M5 的 Transcript、Resume 或 Fork。

已实现：

- `SessionCoordinator` 管理一个 session 的生命周期和输入队列。
- 一个 session 同时最多运行一个 active turn；并发 `run` 请求按顺序排队。
- `TurnRunner` 管理单 turn 的上下文准备、压缩、模型采样、工具派发、后续采样和 terminal state。
- `InputQueue` 按优先级处理 shutdown/interrupt、approval、steer/user input 和 background 输入。
- `AgentSession` 保留为兼容 facade，并暴露 `run`、`steer`、`interrupt`、`shutdown` 和状态查询。
- session signal、调用方 signal、turn signal 形成取消树，并传递到 ModelTransport、ApprovalBroker 和 ToolRuntime。
- turn 结束原因明确区分 completed、max_steps、task_queue_empty、parse_failed、cancelled 和 failed。
- session/turn 状态通过生命周期事件发送，审批等待期间 session 状态为 `waiting_approval`。
- `ContinueReason` 接入 step 结果和 trace，覆盖 normal、parse_retry、transport_fallback 和 recoverable tool error。

## 2. 状态

Session：

```text
created -> ready -> running -> waiting_approval -> ready
                                  |
                                  v
                              closing -> closed
```

Turn：

```text
created
-> preflight_context
-> precompact
-> compacting
-> sampling
-> dispatching_tools
-> awaiting_followup
-> sampling
-> completed | aborted | failed
```

状态事件是观察接口，不是 Transcript。当前事件仍由 CLI/调用方回调消费，持久化属于 M5。

## 3. 取消语义

- `AgentSession.run(request, { signal })` 只取消该调用对应的 turn。
- `AgentSession.interrupt()` 取消当前 active turn，结果返回 `terminalReason: "cancelled"`。
- `AgentSession.shutdown()` 取消当前 turn、拒绝排队请求并关闭 session。
- 模型 transport 和工具 runtime 必须消费 AbortSignal；M4 测试使用可中断的自定义 transport/runtime 验证传播。
- 取消不会自动重放或重复执行已经完成的工具调用；更细的 unknown outcome 恢复策略属于 M5。

## 4. 测试

M4 新增测试覆盖：

- 输入队列优先级。
- 并发 `run` 请求串行化。
- 模型请求取消。
- 工具 runtime 取消。
- steer 在下一次采样边界注入。
- 明确 turn terminal reason。

当前完整检查：

```text
npm run typecheck 通过
npm test          43/43 通过
npm run build     通过
```

## 5. 未完成边界

以下能力不属于 M4，仍待 M5 及以后：

- append-only Transcript。
- session Resume/Fork。
- 崩溃恢复和未确认副作用的 `unknown_outcome` 处理。
- 持久化 input/approval/turn 状态。
- Context checkpoint 的持久化恢复。
