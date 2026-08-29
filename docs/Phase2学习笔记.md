# Phase 2 学习笔记

## 一、Phase 2 的定位

Phase 2 解决上下文预算问题。Phase 1 已经把模型、工具、状态组织成可运行链路，但长任务会产生大量消息，超出模型上下文窗口后运行必然失败。这一阶段的核心是把历史消息控制在预算内，同时尽可能保留对后续决策有价值的信息。

两条主线。

- 预算估算：在无法精确知道 token 数时，用启发式估算加服务端 usage 锚点估计当前上下文规模。
- 信息降级：把历史消息按价值分层，从无损持久化到有损摘要逐级压缩。

数据流如下。

```text
每轮生成前
  -> 估算当前 token
  -> 大工具结果落盘并替换为预览
  -> 超预算则清理旧工具结果
  -> 仍超预算则折叠较早轮次
  -> 仍超预算则整体摘要
  -> 恢复最近文件提示
  -> 用压缩后的历史重建 Prompt
```

掌握这一阶段的标准是能说明每一级压缩在什么条件下触发、保留什么丢弃什么、token 数如何估算、usage 锚点为什么可靠以及压缩结果如何写回历史。

## 二、核心对象与职责边界

### 1. Usage

Usage 表示一次模型调用的 token 计量，包含输入 token、输出 token 和总 token。

它存在三个传递位置。

- ModelStreamEvent.done.usage，由流式客户端在结束事件携带。
- Message.usage，由 runTurn 写进 assistant 消息。
- tokenCountWithAnchor 读取该字段作为锚点。

Usage 是可选字段，缺失时降级为启发式估算。

### 2. ToolResultStorage

ToolResultStorage 负责大工具结果的持久化。核心原理是体积超阈值的工具输出不再进入 Prompt，而是写入磁盘，Prompt 中只保留路径和固定长度预览。

职责边界是它只决定结果是否需要落盘以及替换文本的格式，不参与 token 估算，也不决定清理和摘要策略。

### 3. token-estimator

token-estimator 提供 token 估算函数。核心原理是本地启发式估算配合服务端 usage 锚点。它只输出估算数字，不修改消息。

### 4. CompactionPipeline

CompactionPipeline 是压缩策略编排器。它按固定顺序执行四级压缩，返回压缩后的消息数组和压缩报告。

职责边界是它负责触发顺序和预算判断，具体每级的变换逻辑由内部私有方法实现。

### 5. CompactionSummarizer

CompactionSummarizer 定义摘要接口。当前实现 DeterministicCompactionSummarizer 用确定性的文本拼接代替模型摘要，适合离线测试和确定性验证。

## 三、Token 估算

### 1. 启发式估算

estimateTextTokens 按字符估算。CJK 字符按一个 token 计，非 CJK 字符按四分之一个 token 计，结果向上取整。

CJK 判定覆盖中日韩统一表意文字、扩展区、兼容区、日文假名和全角字符。

messageTokenCount 在内容 token 基础上加上消息名 token 和固定四 token 的开销。

roughTokenCount 支持字符串、单条消息和消息数组三种输入，内部统一转换为 messageTokenCount 求和。

核心原理是 token 与字符存在稳定的数量关系。英文平均四字符一个 token，中文一个字接近一个 token。启发式不准确但零成本且无网络依赖。

优点：本地可算、即时、确定、不需要 API 支持。

缺点：与真实 token 存在偏差，模型不同分词器不同偏差会放大，只适合做预算触发判断，不适合精确计量。

适用场景：预算门槛判断、离线测试、无 usage 时的回退。

### 2. usage 锚点

tokenCountWithAnchor 从消息数组末尾向前扫描，找到最后一条带 usage 的消息，用它的 totalTokens 加上其后消息的启发式估算作为总估算。

核心原理是服务端返回的 usage 是精确值，比启发式估算可靠。最后一次精确计量之后的增量很小，用启发式估算这部分即可，误差被控制在最近一次模型调用之后的新增消息范围内。

实现要点是扫描方向从后向前，因为最近一次模型调用携带的 usage 已经覆盖了它之前的所有历史。

对比：启发式全程估算误差会随历史长度累积；锚点法把精确部分固定在最近锚点，误差只存在于锚点之后。

适用场景：支持流式 usage 的模型。锚点缺失时整体回退到 roughTokenCount。

## 四、工具结果持久化

persistIfLarge 接收工具名、调用标识和输出文本。输出长度不超过上限时原样返回，超过上限时把完整内容写入 session 目录下 tool-results 子目录，Prompt 中替换为持久化标记、文件路径和固定长度预览。

实现要点有三点。

- 调用标识先做字符清洗，只保留字母数字点和连字符，避免路径注入。
- 写入前创建目录，保证多次写入不互相依赖。
- 替换文本结构固定，包含完整长度、落盘路径和预览片段，模型能据此知道完整内容在哪里。

优点：超大输出不占上下文，信息仍可追溯。

缺点：模型无法直接看到被截断部分，后续需要依赖路径自行读取；持久化依赖文件系统可写。

适用场景：搜索、目录列举、长日志、测试输出等容易产生超大文本的只读工具。

## 五、四级压缩策略

### 1. 总览

CompactionPipeline.compact 的触发顺序固定。

- 第一级持久化大结果，始终执行。
- 第二级清理旧工具结果，仅当超预算。
- 第三级折叠较早轮次，仅当超预算。
- 第四级整体摘要，仅当超预算。
- 最后恢复最近文件提示，始终执行。

预算判断使用 totalTokens 加 systemTokens 与 budgetTokens 比较。每级执行后重新计算，只有仍超预算才进入下一级。

这种分级设计的核心原理是按信息损失从小到大排列，先无损再轻度有损再高度有损，避免一上来就丢弃可保留的信息。

### 2. 第一级 持久化大结果

遍历所有 tool 消息，对每条调用 persistIfLarge，内容被替换的消息计数加一。

特点是无损降体积，被移出 Prompt 的内容仍完整保留在磁盘。

### 3. 第二级 清理旧工具结果

收集所有 tool 消息的索引，只保留最后 recentToolTurns 条，其余内容替换为固定标记，工具消息结构本身保留。

核心原理是工具结果的信息价值随轮次递减，早期结果对当前决策影响小，可以用占位符替代。

实现要点是保留最后若干条而不是最早若干条，因为最近的工具结果对当前上下文最相关。

优点：保留工具调用记录的形状，只牺牲内容。缺点：被清理的结果内容不可恢复，除非此前已经落盘。

### 4. 第三级 折叠较早轮次

统计 assistant 消息数量，不超过 collapseAfterTurns 时不折叠。超过时把较早的 assistant 和 tool 消息合并成一条摘要消息，保留前缀和最近轮次。

实现要点有两点。

- 前缀指第一条 assistant 之前的 system 和 user 消息，折叠时不动，保证任务指令不丢失。
- 摘要内容是较早轮次中 assistant 和 tool 消息的截断拼接，截断长度固定，整体再封顶。

优点：把大量历史压缩为一条摘要，保留最近的完整上下文。缺点：摘要不可逆，中间信息永久丢失。

### 5. 第四级 整体摘要

通过 CompactionSummarizer 把历史压缩为一条摘要消息。当前实现 DeterministicCompactionSummarizer 只做确定性文本拼接，不调用模型。

核心原理是当结构性折叠仍不够时，放弃保留历史结构，只保留语义摘要。

当前实现的局限是确定性摘要不做语义理解，只截断拼接，信息损失大。真正的语义摘要需要接入模型，属于后续增强点。

### 6. 恢复最近文件

最后把最近读写过的文件去重后追加为一条 system 消息，帮助模型在历史被压缩后仍知道工作焦点。

## 六、usage 传播链路

usage 从服务端到消息的完整链路如下。

- 流式请求体加 stream_options.include_usage，要求服务端在流中返回 usage。
- SSE 解析时识别不含 choices 的 usage 分片，转换为 Usage 结构。
- done 事件携带 usage 作为结束事件的一部分。
- runTurn 的 generateOnce 从 done 事件取出 usage，写进 assistant 消息。
- tokenCountWithAnchor 读取消息上的 usage 作为锚点。

只有 assistant 消息携带 usage，因为 usage 描述的是模型调用的计量，tool 和 user 消息不涉及。

回退路径是网络失败或非流式降级时 done 不带 usage，锚点缺失，整体回退启发式估算。

## 七、接入主循环

AgentSession 构造时创建 CompactionPipeline，持久化目录为工作目录下的 .swe-agent/session。

每轮生成前执行 compact，budgetTokens 取 maxContextTokens，recentFiles 取工作记忆中的最近读写文件。

压缩结果通过 splice 整体写回 history，避免替换数组引用导致其它持有方看到旧引用。

只要持久化、清理、折叠或摘要中任一步发生，就发出 compact_boundary 事件，供上层标记压缩边界。

recentFiles 来自 workingMemory 的 lastReadFile 和 lastWrittenFile，由读写工具在执行时写入。

## 八、常见问题与解决方法

systemTokens 未接入预算。当前 compact 调用未传 systemTokens，预算判断只覆盖 history，不包含 system prompt、工具描述和项目规则的实际体积。解决方法是把 build 出的完整消息中非 history 部分的 token 数传入 systemTokens。

回退到非流式时 usage 丢失。chat 路径只返回字符串，锚点失效。解决方法是让 chat 也返回 usage，或在回退包装中补充估算。

restoreRecentFiles 重复追加。每次 compact 都追加一条 system 消息，多次压缩后可能累积重复文件提示。解决方法是先移除旧的最近文件消息再追加，或把该信息作为稳定字段处理。

DeterministicCompactionSummarizer 不读 options 参数，摘要质量有限。解决方法是接入模型摘要并遵守 budgetTokens 约束。

clearOldToolResults 的保留数量固定。保留数量过小会丢失近期有用结果，过大则压缩不足。解决方法是根据预算动态计算保留数量。

## 九、与 Phase 1 的关系

Phase 1 预留的压缩插入点在这一阶段被真正使用。双层循环中外层调用 runTurn 之前正是压缩的接入位置。

Phase 1 中 compact_boundary 事件只有定义没有发出，这一阶段接上生产逻辑。

Phase 1 的 ContinueReason 中 context_compacted 仍未被驱动，压缩目前只在每轮生成前被动执行，没有形成主动触发加继续执行的恢复状态机。

## 十、代码阅读顺序

按数据流阅读。

1. src/types.ts 确认 Usage 与 Message.usage。
2. src/model/model-client.ts 确认 stream_options 与 usage 分片解析。
3. src/core/turn.ts 确认 done.usage 到 assistant 消息的传递。
4. src/core/context/token-estimator.ts 确认估算与锚点。
5. src/core/context/tool-result-storage.ts 确认大结果落盘。
6. src/core/context/compaction-pipeline.ts 确认四级策略与触发顺序。
7. src/core/agent-session.ts 确认压缩接入主循环的时机与写回方式。

## 十一、最终结论

Phase 2 的核心成果是建立上下文预算控制，而不是改进模型能力。

- token 估算的关键是启发式用于触发判断，usage 锚点用于精确锚定，两者结合才能兼顾成本与准确性。
- 压缩的关键是分级，按信息损失从小到大逐级触发，避免过度压缩。
- 大结果持久化是无损手段，优先使用。
- 清理和折叠是有损手段，必须受预算门槛约束。
- usage 只有在全链路传递后才有价值，任何一环缺失都会退化为启发式。
- 压缩必须保持消息结构可被后续 Prompt 构建消费，不能破坏角色序列。
- 预算判断必须覆盖完整 Prompt，只覆盖 history 会低估真实占用。
- 压缩报告和边界事件是可观测性的基础，让上层知道压缩何时发生以及减少了多少。

掌握这一阶段后，应能说明任意一轮生成前历史被如何压缩、每个 token 数从何而来、以及压缩为何不破坏任务指令和最近上下文。