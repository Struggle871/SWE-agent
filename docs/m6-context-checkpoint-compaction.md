# M6 设计：Codex 对齐的 Context Checkpoint 与 Compaction

> 状态（2026-09-05）：工作区实现已落地并通过 `npm run check`（75 tests）。由于项目整体仍等待 M4/M5 顺序发布验收，这一状态不代表跳级发布 M6。
> Codex 源码基线：`tmp/openai-codex-source`，commit `2c4a95736bea64256a50f7b8506bd33c181cc85a`。
> 研究原则：只把本地可读源码和测试证明的行为记为 Codex 事实；产品公开文档在当前网络环境返回 403，未取得的内容不作为证据。

## 1. 结论

本节以下差距描述是实现前基线。当前生产路径已不再调用 `CompactionPipeline`；该类仅作为 Phase 2 兼容 fixture 保留。M6 的实际路径由 session-owned `ContextManager`、`CompactionManager` 和 checkpoint-aware reconstruction 组成。

M6 不能只增加一条 summary 消息或一个 `compact_checkpoint` 名称。必须按 Codex 的核心语义完成以下闭环：

```text
canonical append-only rollout
  -> context projection + token status
  -> manual / pre-turn / mid-turn compaction lifecycle
  -> local / remote capability-selected implementation
  -> replacement history installation
  -> window lineage advance
  -> compact checkpoint append
  -> world-state/reference-context baseline append
  -> checkpoint-aware Resume / Fork / rollback replay
```

唯一真源仍是 append-only transcript。Compaction 改变的是“从哪个 replacement history 基点继续构造模型上下文”，不是删除或重写旧 transcript。

## 2. Codex 源码事实

### 2.1 压缩是独立生命周期

Codex 在 `codex-rs/core/src/session/turn.rs` 中提供三个执行时机：

- **pre-turn**：新用户输入和本轮 context update 写入前检查 token status；超出自动压缩阈值、切换到更小 context window 的模型，或 compaction compatibility hash 改变时压缩。
- **mid-turn**：模型需要 follow-up 或有 pending input，且 token limit 已到或显式请求新窗口时，压缩后继续同一 turn。
- **manual**：显式 compact 作为独立 turn 执行。

每次压缩都有 `trigger`、`reason`、`implementation`、`phase` 和 `status`：

```text
trigger:        manual | auto
reason:         user_requested | context_limit | model_downshift | comp_hash_changed
implementation: responses | responses_compaction_v2 | responses_compact
phase:          standalone_turn | pre_turn | mid_turn
status:         completed | failed | interrupted
```

`ContextCompactionItem` 有独立 ID，并产生 started/completed 生命周期事件。准确时序是：analytics attempt 开始后先运行 `PreCompact`；只有它继续时才创建并发出 item started。压缩安装并发出 item completed 后才运行 `PostCompact`。`PreCompact` 停止会以 interrupted 结束且不安装；`PostCompact` 停止只中止后续 turn 流程，不回滚已经完成的 checkpoint，analytics 中该次 compaction 仍是 completed。两种阻断不能合并成同一种事务语义。

### 2.2 Local、Remote 和 Token-budget 不是同一个算法的别名

Codex 根据 provider capability 和 feature 选择实现：

- **local responses summarization**：把专用 checkpoint prompt 作为合成用户输入发送给模型，读取最后一条 assistant 输出作为 summary。
- **remote compaction**：把规范化 history、base instructions、模型可见 tools、reasoning、service tier、prompt cache key 等交给 `/responses/compact` 或 v2 compaction 流程，服务端返回 replacement history。
- **token-budget new context**：不调用摘要服务，建立新的 context window；仍走同一个 compaction lifecycle，产生同类 turn item 和窗口状态。

M6 必须建立 capability-selected `CompactionStrategy`/`CompactionBackend` 边界，不能把 deterministic string join 当作最终实现。允许没有 remote capability 的 provider 使用 local backend，但两者必须输出同一个安装协议和可测试的语义。

### 2.3 Local summary 的 history shape

Codex 的默认摘要提示词要求生成给“另一个继续任务的 LLM”的 handoff，至少包含：当前进度和关键决策、上下文/约束/用户偏好、剩余工作和明确下一步、继续所需的关键数据/示例/引用。

Local compaction 完成后：

1. 从压缩前 history 收集真实用户消息，排除旧 compaction summary。
2. 用户历史有独立硬上限，从最新消息向前保留，必要时对最老的入选消息做 token 级截断。
3. summary 使用稳定 prefix，并作为模型可识别的 `compaction.summary` user-role contextual fragment 放在 replacement history 末尾。
4. 不能仅截取每条 assistant/tool 文本，也不能保留无限 user/system prefix。

这里的“保留用户消息 + handoff summary”是 local backend 的具体输出形状；remote backend 可以返回更丰富的 provider-normalized items，但安装前必须清除陈旧 developer/context wrapper，并重新注入当前 canonical context。

### 2.4 Checkpoint 是完整的 replacement-history 基点

Codex `CompactedItem` 持久化：

- `message`：local summary 文本；remote 模式可为空。
- `replacement_history`：安装到 live context 的完整 history envelope。
- `replacement_history_metadata`：与 history 等长的内部 metadata sidecar；长度不一致视为损坏。
- `mcp_resource_origins`：资源来源 checkpoint。
- `window_number`。
- `first_window_id`、`previous_window_id`、`window_id`。

Codex 成功路径的实际顺序是：backend 返回后先推进 window，在 `replace_compacted_history` 中为 replacement items 补齐稳定 item ID并替换 live history，再依次持久化 `CompactedItem`、full world-state baseline 和 reference turn context，随后重算 usage并发出 item completed。live history 与 `CompactedItem` 使用同一份 envelope 副本，而不是分别生成两个可能漂移的数组。

当前 Codex 的 `persist_rollout_items()` 遇到 append 错误只记录日志，不把错误返回调用方，因此这里不能宣称其 live replace 与多条 rollout append 是原子事务。M6 对模型历史和恢复顺序与 Codex 对齐；针对本项目会抛错的 M5 writer，另在第 6 节定义更强的 durable-before-live 提交规则。

窗口状态在 backend 成功后、live history 替换前推进；成功路径的链式变化是：

```text
window_number += 1
previous_window_id = old window_id
window_id = new UUIDv7
first_window_id 保持不变
```

初始 `window_id` 在 session meta 中持久化，使只读取 rollout 尾部的消费者在第一次压缩前也能识别窗口。

### 2.5 Pre-turn 与 mid-turn 的 context 注入规则不同

Codex 明确区分：

- **pre-turn/manual**：replacement history 不注入 initial context，并清除 reference context；下一次普通 turn 重新注入完整、当前有效的 initial context。
- **mid-turn**：同一 turn 必须立即继续，因此把当前 canonical initial context 插入 replacement history，位置在最后一个真实用户消息之前；没有真实用户消息时放在 summary/compaction item 之前，保证 summary 或 compaction item 仍是末项。

重新注入的不是压缩前复制出来的旧字符串，而是当前 world state 渲染结果。至少包括当前 model/session 环境、AGENTS、权限/cwd、工具可见性和后续里程碑加入的 skills/MCP/collaboration state。remote replacement 中陈旧的 developer 和 context wrapper 必须先过滤。

### 2.6 Token status 是窗口状态，不只是字符估算

Codex 同时维护：

- 当前模型完整 context window hard cap。
- model/provider auto-compact limit。
- limit scope：`total` 或 `body_after_prefix`。
- 当前窗口 prefix/prefill baseline。
- 服务端 usage；缺失时才使用完整 prompt 的保守估算。
- fallback buffer 和每窗口一次性提示状态。

`body_after_prefix` 只计算窗口建立后增长量，但无论 scope 如何，完整 context hard cap 始终生效。压缩安装后重新计算 usage/prefill，不能沿用压缩前锚点。

### 2.7 Resume/Fork/rollback 使用 checkpoint-aware replay

Codex 恢复不是顺序拼接所有消息：

1. 从新到旧扫描 surviving rollout，识别 rollback 要丢弃的最新用户 turn segment。
2. 找到最新仍有效、带 `replacement_history` 的 checkpoint 作为 history base。
3. 只把 checkpoint 之后的 surviving response items 按正序追加。
4. 同时恢复最新窗口编号/ID、reference turn context、world-state full snapshot + 后续 merge patch，以及上轮模型/comp-hash 设置。
5. 旧版无 replacement history 的 checkpoint 只能走明确的 migration/fallback，不能静默当作新格式。

Codex 集成测试要求 compact 后、Resume 后、Fork 后的模型可见历史前缀等价；第二次 compact 后再次 Resume 仍复用最新 checkpoint，不重新调用 summarizer。rollback 跨越 compact 边界时仍由 append-only history 正确重放。

### 2.8 失败、取消和重试语义

- local compact 遇到 transient stream error 使用 provider stream retry budget 和 backoff。
- local compact 请求自身遇到 context-window-exceeded 时，成对保持调用结构地移除最老 history item后重试；如果只剩一个 item 仍超限则失败。
- remote compact 发送前会重写/裁剪过大的 function-call output，使请求本身能进入窗口。
- 模型切换触发的 previous-model compact 可在特定错误下回退到 current model；不能对任意错误盲目 fallback。
- cancellation/turn abort 不重试，状态记为 `interrupted`。
- backend/stream/cancellation 错误发生在安装前时，不会调用 window advance 或 history replacement；旧 live history、窗口号和恢复基点不变。
- `PostCompact` 发生在安装和 item completed 之后；它停止后续流程时不会回滚已安装 checkpoint。
- rollout append 错误在当前 Codex 中被记录后吞掉，不构成可观察的 compaction error。这是本项目不能照搬的持久化缺口，而不是应对齐的保证。
- auto compact 失败会停止当前 agent loop并产生明确错误，不允许同一状态无界重复 compact。

### 2.9 对齐边界：复制语义，不复制持久化缺口

M6 对齐 Codex 的触发时机、backend 分流、replacement-history shape、window lineage、context 注入、生命周期顺序和 reconstruction 结果。由于本项目 M5 的 `RolloutWriter.append()` 会显式失败，且项目约束要求覆盖 checkpoint 写失败，M6 采用更强的提交规则：先计算但不推进下一窗口，durable append 恢复所需的完整 checkpoint 成功后，再把同一份 replacement 安装到 live state。该强化必须有故障注入测试，不能反向描述成上游 Codex 已提供的原子保证。

## 3. 当前项目的逐项差距

### 3.1 Canonical history 与 live history 断裂

当前 `TurnRunner` 克隆 `initialHistory` 后在局部数组上 `splice` 压缩结果，但 `SessionCoordinator` 只在持久化 `message` 时更新 session history。结果是压缩只影响当前 run 的局部请求；下一次 run/Resume/Fork 仍使用压缩前消息。M6 首先要建立 session-owned `ContextManager`，禁止 `TurnRunner` 私自拥有另一个 history 真相。

### 3.2 Transcript 没有 compact 生产/恢复语义

`ResponseItem` 虽定义 `compact_checkpoint`，但：

- `TranscriptKind` 没有 compact checkpoint。
- `TurnRunner` 没有持久化 checkpoint。
- `reconstructSession()` 只拼接 `message`，不会替换 history base。
- session meta 没有初始窗口 ID。
- copied Fork 不理解 checkpoint 边界和有效 replacement history。

这不是“补一个 kind”即可修复；schema、writer、reconstruction、fork projection、index/migration 和测试必须一起更新。

### 3.3 Pipeline 的信息模型与 Codex 不等价

当前 deterministic summarizer：

- 不调用模型，也没有 local/remote backend 能力协商。
- 将 summary 写成 assistant message，而不是可识别的 compaction summary fragment。
- 永久保留全部 user/system prefix，长度无硬上限。
- 每条只保留固定字符片段，无法可靠保留目标、约束、决策、失败尝试和待办。
- 按 assistant 数量折叠，不能保证 tool call/result 配对和 turn 边界。
- 没有 stable item ID、metadata sidecar 或 replacement history 校验。

因此它只能保留为测试 fixture/helper，不能作为 M6 默认生产 backend。

### 3.4 触发点和状态机不完整

当前每个 step 前调用 pipeline，但没有真正区分：

- 新用户输入写入前的 pre-turn compact。
- tool follow-up 之间的 mid-turn compact。
- standalone manual compact。
- context limit、model downshift、comp-hash change 等原因。

`InputQueue` 虽有 `manual_compact` 名称，`SessionCoordinator` 没有提交/消费 API。只有一个无 ID 的 `compact_boundary` 事件，没有 started/completed/failed/interrupted 生命周期。

### 3.5 Initial context/world state 不可恢复

`PromptBuilder` 每次拼接 system prompt；checkpoint 没有 reference context、world-state baseline、当前配置/权限/AGENTS/tool layout 的身份。`recentFiles` 由 pipeline 追加普通 system message，且多次 compact 会重复累积。Resume 无法判断应该全量重注入还是只注入 diff，也无法清除压缩输出里的陈旧指令。

### 3.6 Token budget 不代表真实 request

- pipeline 调用未传 `systemTokens`，压缩判断只看 history。
- `PromptBuilder` 又做一次独立截断，形成双重、不可观测历史改写。
- request 中独立的 tool definitions、项目指令、working memory、pending input 等没有统一预算投影。
- legacy non-stream fallback 可能没有 usage。
- usage anchor 没有窗口编号/prefill，压缩后不会重置。
- 没有 auto-compact limit 与模型 hard context limit 的区分，也没有 scope、buffer 或 model-switch 规则。

### 3.7 Tool output spill 不是稳定引用

当前 spill 只在下一次 compact 扫描时执行，目录固定为 `.swe-agent/session`，文件名使用消息下标。不同 session/step 可能覆盖；transcript 曾经已经记录完整输出；引用没有内容 hash、call ID、大小和重新读取契约。M6 要在 tool result 进入 canonical history 前完成 content-addressed/session-scoped spill，并让 transcript 和 context 同时只保存有界 preview + durable reference。

### 3.8 失败路径没有原子边界

pipeline 没有 AbortSignal、专用 timeout、provider retry、context-overflow recovery 或 single-attempt guard。早期 stage 可能已经写工具结果文件，后续 summarizer 再失败；turn 只得到普通 failed，无法区分旧 history 是否仍有效。没有测试覆盖 compact 中断、超时、backend 错误、checkpoint append 失败和 Resume 损坏 checkpoint。

## 4. M6 目标架构

建议在不改变 JSONL 唯一真源的前提下增加以下真实模块；名称可以随现有目录调整，但职责不能合并回 `TurnRunner`：

```text
src/core/context/
├── context-manager.ts          # live annotated history、projection、baseline、version
├── context-window.ts           # window lineage、prefill、token status、attempt guard
├── token-accounting.ts         # provider usage anchor + full-request estimator
├── compaction-manager.ts       # lifecycle、backend 选择、安装事务
├── compaction-local.ts         # 专用模型 handoff summary
├── compaction-remote.ts        # capability-based remote adapter
├── compaction-history.ts       # user retention、pair normalization、context reinjection
├── world-state.ts              # full snapshot/diff/fingerprint
└── tool-result-store.ts        # session/call scoped spill + hash reference

src/persistence/
├── rollout-schema.ts           # compact/world-state/reference-context kinds
├── reconstruction.ts           # checkpoint-aware reverse scan + forward replay
└── transcript-store.ts         # fork/materialization 调用同一 replay contract
```

`SessionCoordinator` 持有唯一 `ContextManager` 和 `ContextWindowState`；`TurnRunner` 只通过快照/方法读取和提交 item。Compaction 安装必须由 session 串行化，与普通消息 append、manual compact、interrupt 和 Fork 边界共享同一顺序域。

## 5. 强制协议模型

下列是语义最低要求，不是最终字段命名限制：

```ts
type CompactionTrigger = "manual" | "auto";
type CompactionReason =
  | "user_requested"
  | "context_limit"
  | "model_downshift"
  | "comp_hash_changed";
type CompactionPhase = "standalone_turn" | "pre_turn" | "mid_turn";
type CompactionImplementation =
  | "local_responses"
  | "remote_compact"
  | "remote_compaction_v2"
  | "new_context_window";
type CompactionStatus = "completed" | "failed" | "interrupted";

interface ContextWindowLineage {
  windowNumber: number;
  firstWindowId: string;
  previousWindowId?: string;
  windowId: string;
}

interface ResponseItemEnvelope {
  item: ResponseItem;
  metadata?: Record<string, unknown>;
}

interface CompactCheckpointPayload {
  compactionId: string;
  trigger: CompactionTrigger;
  reason: CompactionReason;
  phase: CompactionPhase;
  implementation: CompactionImplementation;
  summary?: string;
  replacementHistory: ResponseItemEnvelope[];
  window: ContextWindowLineage;
  tokenUsage: {
    activeBefore: number;
    activeAfter: number;
    estimateBefore?: number;
    estimateAfter?: number;
    cachedInputTokens?: number;
  };
  resourceOrigins?: Record<string, unknown>;
}

interface WorldStatePayload {
  full: boolean;
  state: Record<string, unknown>; // full snapshot 或 merge patch
  fingerprint: string;
}

interface ReferenceContextPayload {
  model: string;
  compHash?: string;
  cwd: string;
  instructionFingerprint: string;
  toolLayoutFingerprint: string;
  permissionFingerprint: string;
}
```

约束：

- `replacementHistory` 必须有数量、单 item 和总字节/token 硬上限；反序列化时严格校验。
- item ID 在 live install 和 transcript append 前一次性补齐；两侧不得各自生成。
- metadata sidecar 必须与 history 一一对应；模型请求不得泄漏内部 metadata。
- `windowNumber` 单调递增，窗口 ID 满足链式关系；损坏链必须报告，不能自动猜测。
- summary 是 checkpoint 的辅助信息，`replacementHistory` 才是 Resume 的权威模型历史基点。
- world state/reference context 是同一安装边界后的 canonical records；只有包含完整 replacement history 和 lineage 的 checkpoint durable 后，live replacement 和 window advance 才能对当前进程可见。
- checkpoint 后、baseline records 前崩溃时，reconstruction 仍以 replacement history为base，并将 reference context视为缺失，在下一普通turn执行full context injection。

## 6. Compaction 执行协议

### 6.1 通用流程

```text
capture immutable session/step snapshot
  -> compute full-request token status
  -> begin compaction attempt
  -> run PreCompact lifecycle
  -> emit compact item started(compactionId)
  -> select backend by provider capability/config
  -> prepare bounded, normalized compact input
  -> execute with cancellation + retry policy
  -> validate replacement history and metadata
  -> render current initial context according to phase
  -> compute next window lineage without committing
  -> append recovery-complete checkpoint through single writer
  -> install exact persisted replacement history + commit window lineage
  -> append world-state/reference-context baseline records
  -> recompute token status/prefill
  -> emit compact item completed
  -> run PostCompact lifecycle
  -> continue, or abort later turn work without rolling back checkpoint
```

不得先修改 live history 或推进 window 再尝试写 checkpoint。若 JSONL 单次只能 append 一行，checkpoint payload 必须包含恢复所需的完整 replacement history和lineage；checkpoint append失败属于pre-commit failure，旧live state保持不变。后续baseline append失败属于post-commit failure：停止当前session继续采样，但不删除已提交checkpoint；恢复逻辑从该checkpoint重放，并安全回退为“下一turn全量重注入”，不能使用半套diff baseline。`PostCompact`停止同样不回滚已提交checkpoint。

### 6.2 Pre-turn

- 在当前 turn 的新 user item和 context diff进入 history前判断。
- 估算即将进入的 user input、full/diff context、工具布局变化，不能只检查上一轮 usage。
- 成功后清除旧 reference context；本轮按普通 turn 规则注入当前完整 context。
- backend 失败时当前用户输入仍须有明确持久化/错误语义，但不得进入模型采样。

### 6.3 Mid-turn

- 仅在同一 turn 需要 follow-up/pending input时 rollover。
- 使用采样后最新 provider usage；显式 new-context request 与 limit 均可触发。
- current initial context 插入最后真实用户/agent message之前，summary/compaction item保持末项。
- 压缩完成后继续同一个 turn，不重复执行已完成工具，不重新提交旧 user input。

### 6.4 Manual

- 作为独立、不可 steer 的 compact turn进入 session input queue，和 user turn串行。
- 即使 history 为空也产生完整 started/completed 或 failed lifecycle。
- 支持调用方提供 custom compact prompt，但需字节/token 上限和审计；prompt 不作为普通用户消息污染长期 history。
- 中断 manual compact 不改变旧窗口。

## 7. Token accounting 设计

Token status 必须从实际 `ModelRequest` 投影计算，而不是由多个模块分别猜测：

```text
base/model instructions
+ current contextual/world-state items
+ annotated conversation items after normalization
+ model-visible tool schemas
+ images/audio/encrypted payload replacement cost
+ pending incoming user/context items
+ reserved max output / provider-required buffer
```

规则：

1. provider usage 是最新请求的权威锚点，必须关联 request ID、history version 和 window ID。
2. 锚点后的新 item 用模型相关 estimator 增量估算；锚点与当前 history version 不兼容时作废。
3. `contextWindowLimit` 是硬上限；`autoCompactLimit` 是提前 rollover 阈值；两者不能共用一个字段。
4. 支持 `total` 和 `bodyAfterPrefix` scope，后者保存当前窗口 prefill baseline。
5. compact 安装后重新计算 active tokens并建立新窗口 baseline。
6. 缺失 usage 的非流式 fallback 必须返回明确 `estimated` usage，不能伪装成 provider-observed。
7. 超过硬上限前必须停止采样或压缩；`PromptBuilder` 不再拥有静默丢历史的第二条路径。

## 8. Tool result 与 history normalization

- 大结果在进入 transcript/history前 spill；文件路径按 session/call ID隔离，内容带 SHA-256、原长度、MIME/编码和 preview。
- 原始结果文件属于 durable session artifact，其生命周期不能短于引用它的 transcript/Fork。
- 旧 tool body清理必须保留 call ID、tool name、status、durable reference和足够 preview。
- function/tool call与 output必须成对保留或成对移除；normalize 后才能发送模型或 compact backend。
- remote compact 输入超限时优先有界重写旧 tool outputs，再考虑移除最老完整 item group；不能切断调用关系。
- 每个 injected item和单次 replacement history有硬上限，防止某个项目指令、工具 schema、图片或用户消息独占窗口。

## 9. Reconstruction、Resume、Fork 与 rollback

M6 的 `reconstructSession()` 必须返回至少：

```ts
interface ReconstructedContext {
  history: ResponseItemEnvelope[];
  historyVersion: number;
  window: ContextWindowLineage;
  referenceContext?: ReferenceContextPayload;
  worldStateBaseline?: WorldStatePayload;
  previousTurnSettings?: { model: string; compHash?: string };
  latestCheckpointOrdinal?: number;
}
```

恢复算法采用 checkpoint-aware replay：

1. 校验 schema/ordinal/session lineage。
2. 根据 rollback/Fork boundary确定 surviving turn segments。
3. 反向找到最新 surviving checkpoint和恢复元数据。
4. 以 checkpoint replacement history为 base，正向重放后缀。
5. 恢复 full world-state snapshot并应用合法 merge patches。
6. 校验窗口链和 history metadata；失败时产生结构化 corruption/migration error。
7. 当前运行配置重新渲染 context diff或 full injection；绝不把压缩前陈旧 prompt当真相。

Fork 必须复用同一 reconstruction 结果。copied Fork复制 canonical records时，应验证边界不会把 checkpoint 与必要基线拆开；未来 reference Fork也必须产生相同模型可见投影。Resume/Fork 不得调用 summarizer。

若 M6 同时支持 rollback，跨 checkpoint rollback必须按 turn segment计算，而不是简单删除最后 N 条 message；若 rollback仍延期，则 M6 schema/replay必须能识别并拒绝未知 rollback record，不能给出错误历史。

## 10. 错误模型与无限循环保护

至少区分：

- `compaction_interrupted`：AbortSignal、session shutdown或 lifecycle block。
- `compaction_timeout`：backend 超时。
- `compaction_context_overflow`：compact 请求本身无法装入窗口。
- `compaction_backend_failed`：重试耗尽或不可重试错误。
- `compaction_invalid_replacement`：shape、ID、pairing、metadata、size校验失败。
- `compaction_checkpoint_write_failed`：durable append失败。
- `compaction_baseline_write_failed`：checkpoint已提交，但后续world-state/reference-context record写入失败；恢复时强制full injection。
- `compaction_reconstruction_failed`：checkpoint/migration/window lineage损坏。
- `compaction_no_progress`：压缩后 token没有下降到安全阈值。

每个 window/reason/phase只允许有界自动尝试。成功后若 `activeAfter >= activeBefore` 或仍超过 hard limit，不得立刻无界重复；按 no-progress策略停止 turn并要求新 thread/降低输入。所有pre-commit失败和中断都不能推进window number、写completed checkpoint或替换live history；checkpoint提交后的baseline写失败或`PostCompact`停止则保留新窗口并终止后续流程，不能伪装成未安装。

## 11. 测试契约

FakeModel 只能验证协议、顺序和故障注入。涉及真实 streaming usage、provider retry和 remote compact parity的结论必须使用 mock HTTP/SSE 捕获真实 request shape；若具备测试凭据，再增加 opt-in真实模型验证，但不能纳入默认离线测试。

### 11.1 单元测试

- window lineage初始化、推进、恢复、损坏检测和饱和边界。
- `total`/`bodyAfterPrefix` token status、hard cap、buffer和usage anchor失效。
- user history从后向前保留、旧 summary过滤和token级截断。
- tool call/output pairing normalization。
- remote replacement中过期 developer/context filtering。
- pre/manual与mid-turn initial context插入位置。
- replacement history/metadata等长、稳定ID和size cap校验。
- world-state full snapshot、merge patch和fingerprint。
- no-progress/每窗口attempt guard。

### 11.2 集成测试

- manual、pre-turn、mid-turn各自的 started/completed、reason、phase和模型请求形状。
- local/remote backend输出不同但安装和Resume语义等价。
- 第一次和第二次 compact 后继续同一 session。
- compact -> Resume -> Fork 后模型可见history前缀等价，且Resume/Fork不再次摘要。
- model downshift和comp-hash change在pre-turn触发；缺少hash不误触发。
- mid-turn compact后不重复工具副作用，pending input顺序正确。
- compact过程 interrupt、shutdown、timeout、transient retry、不可重试失败。
- compact请求context overflow时按完整item group逐步裁剪；无法恢复时明确失败。
- checkpoint append失败保持旧live history/window；进程在checkpoint后、baseline前崩溃仍可安全恢复并全量重注入。
- PreCompact停止不产生checkpoint；PostCompact停止保留completed checkpoint但终止后续turn流程。
- transcript尾损坏、未知schema、metadata长度不匹配、窗口链损坏均拒绝或走显式migration。
- spill artifact使用临时session目录，跨Resume/Fork引用有效且无文件名冲突。
- 删除派生index后仍可仅从JSONL重建同一context。
- 多次压缩不重复recent files/AGENTS/权限context。
- replacement history或单item超硬上限时拒绝安装。

所有测试使用临时目录，不得写项目 `.swe-agent/`、`tmp/` 或用户目录。

## 12. 交付顺序与完成门槛

M6 不是“先做简版 checkpoint、以后再对齐”。建议拆成可审查提交，但只有全部完成才标记 M6 已实现：

1. annotated `ContextManager`、统一 full-request token accounting、移除双重截断。
2. session-scoped tool result spill和call/output normalization。
3. compaction协议类型、窗口状态、lifecycle和local backend。
4. capability-selected remote backend及request/response校验。
5. replacement-history checkpoint、world-state/reference-context baseline和原子安装。
6. checkpoint-aware reconstruction、Resume、copied Fork和migration。
7. pre-turn、mid-turn、manual三条控制流与model-switch触发。
8. 完整故障注入、request snapshot和Resume/Fork等价测试。

完成门槛：

- 本文第 11 节测试全部通过。
- `npm run check` 通过。
- README只能在上述闭环完成后把M6改为“已实现”。
- 不得用 deterministic summary、FakeModel usage或普通 `Message[]` 拼接证明真实模型摘要、流式usage、retry或remote compact已经对齐。
- 不得把 Hooks、Skills、MCP 尚未实现作为省略 world-state/lifecycle/resource-origin 字段的理由；M6 必须定义并持久化可扩展的真实协议，后续模块接入时不破坏 checkpoint compatibility。

## 13. M6 非目标

以下能力可以保留在后续里程碑，但不能破坏本设计的协议：

- 通用 Hooks 配置/脚本发现属于 M9；M6 仍必须实现可阻断的 compaction lifecycle调用点和 durable结果状态。
- Skills/分层 AGENTS 完整加载属于 M7；M6 的 world state必须支持这些section并用fingerprint识别变化。
- MCP runtime属于M9；M6 checkpoint保留resource-origin扩展位，不能把MCP内容混成不可更新的summary文本。
- reference/paginated Fork和大历史lazy reverse reader可后续优化；M6的copied Fork和eager replay必须先达到相同语义。
- SQLite/trace是派生层，不得成为checkpoint恢复依赖。

性能优化可以延期，模型可见历史、窗口lineage、恢复、失败和持久化语义不能延期或简化。

## 14. 源码证据索引

- `codex-rs/core/src/session/turn.rs`：pre-turn/mid-turn触发、model downshift/comp-hash、backend选择和失败控制流。
- `codex-rs/core/src/session/context_window.rs`：hard context、auto-compact scope、prefill和buffer计算。
- `codex-rs/core/src/compact.rs`：local summary、用户消息保留、context注入位置、retry和checkpoint安装。
- `codex-rs/core/src/compact_remote.rs`、`compact_remote_v2.rs`、`compact_remote_request.rs`：remote请求、输出过滤、fallback和replacement安装。
- `codex-rs/core/src/compact_token_budget.rs`：不摘要的新context window仍走compaction lifecycle。
- `codex-rs/core/src/session/mod.rs`：`replace_compacted_history`、world-state/reference-context持久化和usage重算。
- `codex-rs/core/src/context_manager/history.rs`：annotated history、normalization、token estimation和baseline。
- `codex-rs/core/src/session/rollout_reconstruction.rs`：reverse scan、replacement base、suffix replay、rollback和window恢复。
- `codex-rs/core/src/state/auto_compact_window.rs`：window number/ID/prefill/attempt状态。
- `codex-rs/history/src/lib.rs`、`history/src/rollout_payload.rs`：`CompactedItem`和wire validation。
- `codex-rs/prompts/templates/compact/`：默认checkpoint prompt与summary prefix。
- `codex-rs/core/tests/suite/compact.rs`、`compact_remote.rs`、`compact_remote_parity.rs`、`compact_resume_fork.rs`：行为和恢复契约。

## 15. 工作区实现映射

2026-09-05 的实现按本设计落在以下边界：

- `src/core/context/context-manager.ts` 和 `context-window.ts`：唯一 live annotated history、usage anchor、prefill、UUIDv7 window lineage 和 attempt guard。
- `src/core/context/compaction-manager.ts`：manual/pre/mid lifecycle、backend 选择、local handoff、remote/remote-v2 capability contract、new-context、retry/timeout/overflow、replacement 校验和 durable-before-live 安装。
- `src/persistence/rollout-schema.ts`、`reconstruction.ts` 和 `transcript-store.ts`：v1 读取兼容、v2 checkpoint/baseline/rollback、latest-surviving-checkpoint replay，以及 Fork 的独立窗口身份。
- `src/core/session-coordinator.ts`：compaction 与普通 turn 共用 session 串行域；消息 append 成功后才更新 live context；baseline post-commit failure 会停止当前 session。
- `src/model/model-client.ts`：OpenAI Responses `/responses/compact` unary adapter。remote-v2 不在通用 Chat transport 上虚假声明，只有 provider transport 明确报告 v2 capability 时才选择。
- `tests/unit/context-compaction.test.ts`、`tests/integration/m6-compaction.test.ts` 和 model/persistence tests：覆盖第二次 compact、Resume/Fork/rollback、pre/mid/manual、tool 副作用、hooks、model downshift、comp-hash、真实 HTTP request shape、spill、timeout/retry/cancel/shutdown、overflow、invalid replacement、no-progress 和 checkpoint/baseline write failure。

与上游 Codex 的主要有意差异是第 2.4/2.8 节已经说明的本项目强化：checkpoint 必须 durable append 后才切换 live history；上游当前 rollout append 错误处理不能被描述成同样的原子保证。通用 OpenAI-compatible Chat provider 不会被假定支持 Codex 专用 remote-v2，只有 transport 明确报告 capability 时才选择；内置 OpenAI adapter只实现真实的 unary `/responses/compact` 请求。项目当前模型协议只接收 text/tool-call message，因此图片、音频和 encrypted item 不会被虚构成已支持的输入类型；一旦 M2 协议扩展这些 item，M6 的 metadata/size/resource-origin checkpoint 边界可以直接承载。通用 Hooks 发现、Skills/MCP runtime、reference/paginated Fork 和 SQLite/trace 仍属于后续里程碑，本实现只保留 M6 所需的 executable callback 与 durable 扩展字段。
