# Phase 3 M2 学习笔记：协议类型和模型事件

## 一、M2 要解决的核心问题

M0 和 M1 的执行链已经能安全地调用工具，但模型输出仍然以一段字符串为中心。字符串协议要求模型把工具名称和参数编码进自定义 JSON 或 ReAct 文本，再由 `OutputParser` 解析。这个方式能工作，但模型实际产生的原生 tool call、文本增量、usage 和传输状态无法直接表达。

M2 的目标是把模型响应从字符串升级为有类型的事件流，使核心循环能区分文本、推理、原生工具调用、usage、传输警告和响应结束。字符串解析保留为兼容能力，不再是所有模型输出的唯一表达方式。

M2 的完成边界是协议和流式模型接入，不是整个 v2 架构重写。当前仍保持单 Agent、单 Step 单工具执行；ToolRouter、ToolRuntime 拆分、并行工具调用、Transcript、Resume、Fork、Hooks、Skills、MCP 和多 Agent 不属于本阶段。

## 二、协议驱动的分层方式

### 2.1 协议层的职责

协议层定义跨模块稳定的数据契约，不负责模型 HTTP 请求，不负责工具权限，不负责文件操作。它位于模型实现、会话循环和工具执行之间，作用是统一各模块对状态和事件的理解。

当前协议文件位于 `src/protocol/`：

- `ids.ts` 定义关联标识符。
- `usage.ts` 定义模型用量结构和规范化逻辑。
- `items.ts` 定义响应项和工具输出。
- `model-events.ts` 定义模型请求、模型能力和模型事件。
- `errors.ts` 定义 Agent 错误的判别联合。
- `agent-events.ts` 定义更高层的协议事件。
- `index.ts` 提供统一导出入口。

协议层的核心原则是先定义状态语义，再由不同 provider 映射到这些语义。这样模型供应商的字段差异不会扩散到 `runStep`、`Executor` 和会话状态中。

### 2.2 协议化带来的收益和代价

收益：

- 文本增量和工具调用可以同时表达，不需要等待完整字符串。
- 工具调用拥有独立的 `callId`，执行、审批、审计可以准确关联。
- usage、request、session、turn 可以形成完整追踪链。
- provider 差异集中在 transport adapter，核心循环只消费统一事件。
- 错误可以按 `kind` 分支处理，不需要依赖错误文本。

代价：

- 类型数量增加，协议演进需要维护兼容关系。
- 同一个响应要在 provider 事件、Agent 事件、历史项和工具结果之间转换。
- 事件顺序、重复事件、缺失字段和半截 JSON 都必须处理。
- 旧的字符串历史结构仍然存在，M2 形成了协议类型和旧消息类型并存的过渡状态。

适用场景：

协议层适合存在多个模型 provider、需要流式输出、工具调用、审批、审计或恢复能力的 Agent 系统。只使用一次非流式文本请求的脚本不需要这么完整的事件协议。

## 三、Branded ID 与关联上下文

### 3.1 类型原理

`SessionId`、`TurnId`、`StepId`、`RequestId`、`CallId` 和 `HistoryOrdinal` 都是 branded type。它们运行时仍然分别表现为字符串或数字，TypeScript 编译期却把它们视为不同类型。

branded type 的作用是阻止不同语义的 ID 被随意互换。字符串本身不能说明用途，品牌类型把用途加入类型系统。`ids.ts` 同时提供创建函数和运行时校验函数，弥补 TypeScript 类型在运行时消失的问题。

### 3.2 各 ID 的生命周期

- `SessionId` 标识一次完整 Agent 会话。
- `TurnId` 标识会话中的一次完整用户任务处理，从接收任务持续到最终回答或中止。
- `StepId` 标识 Turn 内的一次模型推进和随后的零个或一个工具处理。
- `RequestId` 标识一次提交给模型 transport 的请求。解析重试会产生新的 request。
- `CallId` 标识一次具体工具调用。原生 provider 提供的 ID 被保留，缺失时由系统生成。
- `HistoryOrdinal` 标识历史顺序，必须是非负整数。

当前 `AgentSession` 在启动时创建 `SessionId`，每次执行 `run` 创建一个 `TurnId`，Turn 的每次循环创建 `StepId`，每次实际模型请求创建 `RequestId`。解析重试发生在同一个 Step 内，但会创建新的 RequestId。`CallId` 从原生模型事件进入 `AgentAction`，旧文本协议则在 step 层生成。`Executor` 优先使用 action 中的 `CallId`，因此审计记录和模型事件使用同一个调用标识。

### 3.3 优点、限制和适用场景

优点是降低关联错误，尤其能避免把 request ID 当成 call ID 或把不同会话的事件混在一起。它不提供持久化、不提供唯一性证明，也不能阻止外部系统伪造合法格式的字符串。需要跨进程恢复或全局查询时，还必须增加 transcript 和索引。

当前适用于内存会话、事件回调、工具审计和测试断言。真正的 Resume、Fork 和跨进程追踪需要把这些 ID 写入持久化事件。

常见问题及处理：

- 外部 provider 返回空 call ID 时使用系统生成的 `CallId`。
- 运行时只校验非空，不能把 provider ID 当作安全凭据。
- 返回结果没有携带 `requestId` 会导致 usage 和最终响应无法关联，因此 `StepResult` 和 `AgentStep` 都保存 request 关联。
- 只给工具事件生成 ID 而不给 session、turn 和 step 生成 ID，会导致审计只能定位动作，不能定位动作所属的执行上下文。

## 四、ResponseItem：把历史从消息升级为响应项

### 4.1 核心原理

`ResponseItem` 使用判别字段 `kind` 表示历史项的语义。当前定义覆盖用户文本、assistant 文本、assistant reasoning、tool call、tool result、compact checkpoint、context injection 和 turn aborted。

每种项都携带该语义所需的字段。tool call 保存 `CallId`、工具名称和结构化 input；tool result 保存工具名称、调用关联和 `ToolOutput`；checkpoint 保存压缩窗口和摘要。

这种结构与旧 `Message` 的区别是：`Message` 主要表达 role 加字符串 content，`ResponseItem` 表达一次响应中的具体业务事件。前者适合兼容 Chat Completions，后者适合 transcript、恢复、审计和上下文投影。

### 4.2 优点、限制和适用场景

优点是历史语义清晰，工具调用不必伪装成 assistant 文本，压缩和中断可以留下可追溯记录。缺点是需要设计项之间的关联和版本兼容，模型 provider 通常不能直接消费 `ResponseItem`，仍然需要转换成 provider 的输入格式。

适用场景是 append-only transcript、恢复、fork、上下文窗口投影和事件回放。M2 只建立类型基础，尚未把当前内存 `Message[]` 完整改造成持久化 `ResponseItem` transcript。

常见问题及处理：

- 不应把完整工具输出直接塞进所有历史项，`ToolOutput` 保留截断和落盘引用字段。
- 不应把 compact checkpoint 当作删除原始历史的替代品，checkpoint 应该保留窗口边界和摘要来源。
- 不应使用字符串内容推断 item 类型，必须通过 `kind` 做判别。

## 五、Usage：模型用量的统一表示

### 5.1 核心原理

`Usage` 统一表示 `inputTokens`、`outputTokens` 和 `totalTokens`，并可选记录 `cachedInputTokens`。`normalizeUsage` 把缺失、负数、非有限数归一化为可用数值，并在总量缺失时使用输入和输出之和。

模型 provider 的字段名称不同，OpenAI Chat Completions 使用 `prompt_tokens`、`completion_tokens` 和 `total_tokens`。transport 必须在边界处完成字段映射，核心循环只接收统一的 `Usage`。

### 5.2 usage 与 request 的关联

`ModelRequest` 创建 `RequestId`。模型事件流中的 usage 事件带有对应的 request ID，`runStep` 同时把 usage 和 request ID 放进 `StepResult`，会话再保存到 `AgentStep`。这样可以把预算统计、上下文估算和 provider 返回的真实用量关联到一次具体请求。

### 5.3 优点、限制和适用场景

真实 usage 比字符估算更准确，适合上下文预算、成本统计和 provider 性能分析。缺点是 provider 可能不返回 usage，流式 usage 可能位于最后一个分片，缓存 token 的语义也可能不同。因此 usage 只能作为可靠锚点，缺失时仍需要估算器。

当前适用于 token budget、上下文压缩和执行轨迹记录。M2 没有实现成本计算、价格表、重试统计或完整可观测性指标。

常见问题及处理：

- 不能把估算值伪装成 provider usage，必须区分真实 usage 和估算结果。
- 不能只在 `chat` 返回 usage，流式 transport 也要消费最后的 usage 分片。
- 不能让 usage 只存在模型客户端内部，否则 session 和 compaction 无法使用真实预算。

## 六、ModelTransport 与 provider 适配

### 6.1 接口职责

`ModelTransport` 只暴露两个能力：

- `stream(request, signal)` 返回 `AsyncIterable<ModelEvent>`。
- `capabilities()` 返回当前 provider 的模型能力。

`ModelRequest` 包含 request ID、模型消息、工具定义、temperature 和最大输出 token 数。`ModelCapabilities` 当前描述原生 tool call、流式文本、usage 和 reasoning delta 能力。

核心循环依赖 `ModelTransport`，不依赖 OpenAI 具体字段，也不依赖 SSE 解析细节。provider 客户端负责把 HTTP、SSE 和供应商字段转换成统一事件。

### 6.2 原生 transport 与 legacy adapter 的区别

原生 transport 能直接产生结构化 `tool_call_started`、`tool_call_delta` 和 `tool_call_completed`，因此核心循环不需要从文本中猜测工具调用。它适用于 provider 支持原生工具协议的场景。

`LegacyModelTransportAdapter` 把旧 `ModelClient` 的 `chat` 或旧文本 `stream` 包装成 `response_started`、`text_delta`、`usage` 和 `response_completed`。它的 `nativeToolCalls` 为 false，文本仍交给 `OutputParser`。它适用于旧 provider、测试替身和暂时没有原生工具协议的模型。

原生 transport 的优势是语义准确、参数结构稳定、工具调用不依赖文本格式。代价是要处理 provider 专用事件格式和兼容差异。legacy adapter 的优势是迁移成本低、不会破坏已有模型实现；代价是仍受字符串格式、解析失败和模型提示约束影响。

### 6.3 能力声明的作用

能力声明不是装饰信息，而是核心循环的分支依据。`nativeToolCalls` 为真时，turn 优先使用结构化工具事件；为假时，turn 才使用 `OutputParser`。`streamingText`、`usage` 和 `reasoningDeltas` 可以让后续循环决定是否展示增量、等待 usage 或记录推理事件。

能力声明必须描述实际 transport 行为，不能只根据 provider 名称推断。否则核心循环会走错误分支，表现为原生调用被当成文本解析，或者在 provider 不支持能力时等待永远不会到来的事件。

## 七、ModelEvent 事件流机制

### 7.1 事件类型和语义

模型事件包括：

- `response_started`：一次模型请求开始，携带 `RequestId`。
- `text_delta`：assistant 文本增量。
- `reasoning_delta`：推理文本增量。
- `tool_call_started`：发现一个工具调用及其 `CallId` 和名称。
- `tool_call_delta`：工具参数 JSON 的增量片段。
- `tool_call_completed`：工具参数收集完成，携带结构化 input。
- `usage`：模型用量。
- `transport_warning`：传输层出现可恢复或不可恢复的警告。
- `response_completed`：响应结束及结束原因。

事件流是有顺序的异步迭代器。事件消费者不能假设一次 `yield` 就对应一个 token，也不能假设工具参数一定在一个分片中完成。事件必须按类型分支，并在收到 completed 事件后才使用完整工具参数。

### 7.2 tool call 参数的增量处理

OpenAI SSE 的工具参数通常以字符串片段到达。transport 为每个工具调用维护按索引分组的状态，持续拼接参数片段，最后执行 JSON 解析并产生 `tool_call_completed`。

工具名称也可能在不同分片到达。实现必须先累计名称，在名称可用时发出 started 事件；如果 started 事件过早发出空名称，turn 无法定位工具，后续执行会失败。

参数解析失败属于协议或传输层问题，不能把半截 JSON 直接交给工具。只有完成 JSON 解析后，结构化 input 才能进入 M1 的 schema 校验和 preflight。

### 7.3 事件顺序的设计取舍

响应开始必须先于文本、工具和 usage 事件，便于建立 request 上下文。工具完成事件需要在参数完整后产生。usage 常常靠近响应结束，但 provider 不保证所有响应都提供 usage。响应完成用于结束消费状态，即使响应没有文本也必须产生。

事件顺序越严格，消费端越容易实现，provider 适配器的约束越高。当前实现选择在 transport 边界规范化事件顺序，以减少核心循环中的供应商分支。

## 八、OpenAI Chat Completions SSE 适配

### 8.1 实现流程

OpenAI transport 将模型请求转换成 Chat Completions 请求体，并把工具定义映射为 function tool。响应体通过 `ReadableStream` 获取，使用 `TextDecoder` 解码，按空行分隔 SSE 块，再读取 `data:` 行。实际解析集中在 `src/model/openai-sse.ts`，legacy `stream()` 和 native transport 共享这一解析器，避免维护两套 SSE 状态机。

每个 JSON 分片分别处理文本、finish reason、usage 和 tool calls。工具调用按 provider 提供的 index 聚合，调用 ID 优先使用 provider 值，缺失时生成系统 ID。参数聚合结束后解析为 `unknown`，由 turn 再转换为工具需要的对象结构。

### 8.2 非流式兼容和失败回退

原生流式请求在网络失败、HTTP 非成功或响应缺少 body 时产生 `transport_warning`，随后使用已有 Chat 客户端的非流式重试逻辑。这样 provider 暂时不支持流式时仍可完成请求。

回退的优点是保留既有重试策略和旧 provider 兼容性。缺点是回退会产生第二次模型请求，延迟和 token 消耗增加，原生 tool call 能力也退化为文本协议。warning 必须被记录，不能把回退伪装成原生流式成功。

### 8.3 常见 SSE 问题及处理

- 一个 JSON 分片可能跨多个网络 chunk，必须维护 buffer，不能按单次读取直接解析。
- SSE 使用空行分隔事件，处理时要兼容 CRLF 行尾。
- `data: [DONE]` 不是 JSON，必须单独处理。
- usage 可能出现在没有 choices 的分片中，不能只处理有 choices 的响应。
- tool call 参数可能分片，必须按 index 和 call ID 聚合。
- 响应结束前的残余 buffer 需要处理，否则最后一个事件可能丢失。
- AbortSignal 取消后必须停止读取并抛出取消原因，不能继续执行工具。

当前实现覆盖了主要 SSE 分片、tool call、usage 和回退路径；完整的 provider 重试、限流、超时和跨平台取消策略仍需要后续增强。

## 九、turn 层如何消费模型事件

### 9.1 generateOnce 的职责

`generateOnce` 是事件到 turn 结果的聚合器。它负责：

1. 发出流开始事件。
2. 消费模型事件并转发模型事件观测。
3. 拼接文本 delta。
4. 按 `CallId` 收集工具名称和 input。
5. 保存 request ID 和 usage。
6. 在事件结束后返回完整文本或第一个完整工具调用。

它不执行工具，也不处理权限。这样模型聚合和工具执行保持边界清晰。

### 9.2 原生和 legacy 的分支

当 transport 声明支持原生 tool call 且收到了完整工具调用时，turn 直接创建 `AgentAction.tool_call`。该 action 保存工具名称、结构化参数和原生 `CallId`，不经过 `OutputParser`。

当 transport 不支持原生工具调用时，turn 对完整文本使用 `OutputParser`。JSON 和 ReAct 的解析、未知工具判断和 parse retry 仍然保持原有行为。

当原生 transport 只返回 assistant 文本时，turn 将文本作为最终回答处理。这个分支与 legacy 模型不同，因为原生文本不需要强制伪装成 JSON action。

### 9.3 M1 安全链路没有变化

结构化 tool call 只改变 action 的来源，不改变 action 的执行入口。`Executor` 仍然是唯一工具执行入口，顺序仍然是参数规范化、workspace preflight、命令风险分析、preview、权限决策、审批、执行前复检、runtime 执行和审计。

因此模型原生工具协议不是安全边界。工具名称和 input 仍然是不可信输入，不能因为它们来自结构化字段就跳过 schema、路径、命令和权限校验。

## 十、Session、Turn 和 Step 的关联

`AgentSession` 是当前会话级编排入口。一次会话创建 `SessionId`，一次 `run` 创建一个 `TurnId`，Turn 内每次 `runStep` 创建一个 `StepId`，每次实际生成模型请求创建新的 `RequestId`。模型事件回调、工具调用、审计记录和 `AgentStep` 围绕这些 ID 组织。

`AgentStep` 保存 action、observation、原始输出、session ID、turn ID、step ID、request ID 和 usage。这样执行轨迹不仅能说明做了什么，还能定位所属任务轮次、具体推进步骤、模型请求和 token 消耗。

当前事件回调同时包含旧的 CLI 事件和 M2 的模型事件。旧事件用于保持 CLI 行为，`model_event` 用于观察完整协议流。这个并存状态属于迁移阶段，后续可以让 CLI 直接消费更稳定的协议事件。

优点是不会一次性破坏现有 CLI、FakeModel 和 M1 测试。缺点是旧事件和协议事件存在重复表达，事件消费者需要明确自己依赖哪一层。重构为统一事件总线属于后续阶段，不应在 M2 通过增加更多旁路事件解决。

## 十一、错误分类与控制流

`AgentError` 使用 `kind` 和 `recoverable` 表示错误类别，当前包括 configuration、transport、protocol、tool_validation、tool_runtime、permission 和 cancelled。

分类原则如下：

- configuration 表示配置不可用，当前定义为不可恢复。
- transport 表示模型网络或 provider 传输问题，允许重试。
- protocol 表示 provider 输出不符合协议，通常允许重新请求或走兼容路径。
- tool_validation 表示工具参数不合法，允许模型修正参数。
- tool_runtime 表示工具执行失败，是否重试取决于工具副作用。
- permission 表示权限或审批未通过，可以重新请求审批或调整操作。
- cancelled 表示用户或系统主动取消，不应自动重试。

判别联合的优点是控制流依赖稳定字段，错误文案可以变化且可以本地化。限制是分类本身需要维护，错误可能同时满足多个语义，必须制定优先级。当前 M2 建立了类型和识别函数，完整地把所有旧异常转换为 `AgentError` 仍是后续工作。

常见问题及处理：

- 不能只根据中文错误文本决定是否重试。
- transport warning 不能直接等同于成功，必须标明是否可恢复。
- 取消错误不能被普通 transport retry 覆盖。
- 工具拒绝和工具执行失败必须区分，前者通常意味着 runtime 没有运行。

## 十二、FakeModel 的测试价值和边界

FakeModel 的 transport 产生确定的原生事件序列，用于验证协议消费者和执行链路。它能证明事件顺序、call ID 传递、usage 关联、step 分支和 M1 preflight 是否按预期工作。

FakeModel 不能证明真实 provider 的网络行为、SSE 分片边界、usage 返回、限流、重试、响应延迟和并发特性。因此测试必须把 FakeModel 测试和 OpenAI SSE 解析测试分开：前者验证核心协议和链路，后者验证 provider adapter 的字段映射和分片聚合。

测试应覆盖以下不变量：

- 原生 tool call 事件顺序稳定。
- 同一个调用的 started、delta 和 completed 使用同一个 call ID。
- usage 能关联到 response request ID。
- native tool call 进入现有 Executor，而不是直接调用工具 runtime。
- legacy chat-only model 能被转换为文本事件并继续使用 parser。
- provider SSE 的 tool call 参数分片最终只能形成完整 JSON input。
- 审批拒绝、路径越界和工具执行错误仍然阻止或记录 runtime 行为。

## 十三、M2 与后续阶段的区别

M2 解决的是模型输出协议和事件表达。它回答模型产生了什么、事件如何传输、调用如何关联。

M3 规划解决工具暴露、路由、注册和 runtime 的分离。它回答模型能看到哪些工具、哪些调用可以进入执行器。

M3.5 规划解决 Shell tokenizer、命令链 AST 和 SandboxProvider。它回答命令风险如何进行更精确的静态分析，以及如何提供 OS 级隔离。

M4 以后规划解决会话状态机、Transcript、Resume、Fork、Hooks、Skills、MCP、任务图和多 Agent。它们回答历史如何恢复、扩展如何接入、任务如何调度和多个执行主体如何协作。

不能通过在 M2 中提前创建这些目录或空接口来声称完成后续能力。只有当对应 runtime、状态转换、测试契约和失败路径都落地后，才算完成相应阶段。

## 十四、需要掌握的实现检查点

- 能说明为什么字符串 action 不能完整表达原生 tool call。
- 能区分 `ResponseItem`、`ModelEvent`、`AgentEvent`、`AgentAction` 和 `ToolResult` 的职责。
- 能说明 `SessionId`、`TurnId`、`StepId`、`RequestId` 和 `CallId` 的生命周期差异。
- 能解释 `ModelTransport` 为什么只暴露事件流和能力，而不暴露 provider 字段。
- 能说明 legacy adapter 为什么把旧模型标记为不支持 native tool calls。
- 能按事件顺序解释原生工具参数从 SSE 分片到 Executor 的转换过程。
- 能说明 usage 为什么需要在 transport 边界归一化，并继续传到 turn 和 session。
- 能说明原生 tool call 为什么仍然必须经过 M1 安全链路。
- 能区分 provider fallback、protocol parse retry、tool failure 和 cancellation。
- 能说明 FakeModel 能验证什么，以及不能验证什么。
- 能指出当前 M2 仍使用内存 `Message[]`，尚未完成 transcript 持久化和恢复。

## 十五、最终知识闭环

模型 provider 产生异构流式响应，transport 将其转换为统一 `ModelEvent`。事件携带 request ID、call ID 和 usage，step 聚合事件并形成结构化 action。session 为执行过程补充 session ID、turn ID 和 step ID，Executor 接收 action 后继续执行 M1 的完整安全链路，结果和关联信息写入历史、轨迹和审计。

legacy 模型沿同一条 transport 入口进入系统，但只产生文本事件，step 再使用 `OutputParser` 解析。由此，M2 同时实现了新协议的原生表达和旧协议的可运行兼容，而没有把 provider 细节或结构化调用绕过核心执行边界。
