# M2 实现记录：协议类型和模型事件

更新时间：2026-08-30

## 当前结论

M2 已接入现有 `AgentSession -> runStep -> Executor` 主链。一次 `AgentSession.run()` 构成一个 Turn，Turn 内每次模型推进和工具处理构成一个 Step。模型输出先进入 provider-neutral `ModelTransport` 事件流，再由 step 根据能力选择原生 tool call 或 legacy JSON/ReAct parser。原生调用不会绕过 M1 的 preflight、preview、permission、approval、revalidation、runtime 和 audit。

## 已实现范围

- `src/protocol/ids.ts` 提供 `SessionId`、`TurnId`、`StepId`、`RequestId`、`CallId`、`HistoryOrdinal` branded 类型，以及非空/非负校验和 ID 工厂。
- `src/protocol/items.ts` 提供 `ResponseItem`、`ToolOutput` 和 compact window 类型，为后续 transcript 做协议基础；M2 不实现持久化 transcript、resume 或 fork。
- `src/protocol/model-events.ts` 提供 `ModelRequest`、`ModelEvent`、`ModelCapabilities` 和 `ModelTransport`。
- `src/model/transport.ts` 将只提供旧 `chat()` 或旧文本 `stream()` 的模型适配为事件流。
- `src/model/openai-sse.ts` 提供唯一的 Chat Completions SSE 分片解析器；legacy `stream()` 和 OpenAI native transport 共享文本、tool-call、usage 和 finish reason 的解析结果，流式失败仍回退兼容的重试 chat 请求。
- `FakeModelClient` 的 transport 产生结构化 tool call 事件，用于协议与执行链路测试。
- `AgentAction.tool_call`、assistant history 和 tool history 保存 call id 元数据；usage 与 request id 在事件流中关联。

## 明确边界

M2 本身仍保持单 Agent、单 Step 模型；M3/M3.5 已在后续实现记录中接入 ToolRouter/ToolRuntime、并发 gate、Shell AST 和 SandboxProvider。Transcript/Resume/Fork、Hooks、Skills、MCP 和多 Agent 仍留在后续里程碑。

## 验证

`npm run typecheck`、`npm test` 和 `npm run build` 通过。测试覆盖 branded ID 运行时校验、legacy adapter、FakeModel 原生事件顺序、OpenAI SSE 原生 tool call/usage 解析，以及原生 call id 进入 M1 审计链路。
