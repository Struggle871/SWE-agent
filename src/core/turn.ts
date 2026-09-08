import type {
  AgentAction,
  AgentContext,
  Message,
  ToolResult,
  Usage,
} from "../types.js";
import type { AgentEvent, ContinueReason } from "./events.js";
import { createCallId, type CallId, type RequestId } from "../protocol/ids.js";
import type { ModelEvent } from "../protocol/model-events.js";
import { Executor } from "./executor.js";
import { OutputParser } from "./output-parser.js";

export interface StepResult {
  action: AgentAction | null;
  raw: string;
  observation?: ToolResult;
  finalAnswerText?: string;
  usage?: Usage;
  requestId?: RequestId;
  continueReason?: ContinueReason;
  toolCalls?: NativeToolCall[];
  toolResults?: ToolResult[];
  finishReason?: string;
  reasoning?: string;
}

export interface StepOptions {
  history: Message[];
  generate: () => AsyncIterable<ModelEvent>;
  parser: OutputParser;
  knownTools: Set<string>;
  executor: Executor;
  ctx: AgentContext;
  parseRetry: number;
  nativeToolCalls?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  onMessageAppended?: (message: Message) => Promise<Message | void>;
  onToolCallStarted?: (call: { callId: CallId; name: string; input: Record<string, unknown> }) => Promise<void>;
  onToolCallCompleted?: (call: { callId: CallId; result: ToolResult }) => Promise<ToolResult | void>;
}

export async function runStep(opts: StepOptions): Promise<StepResult> {
  const { history, parser, knownTools, executor, ctx, parseRetry, nativeToolCalls = false, onEvent } = opts;
  throwIfAborted(opts.signal);
  let generated = await generateOnce(opts.generate, onEvent, opts.signal);
  let raw = generated.raw;
  let continueReason: ContinueReason | undefined = generated.continueReason;
  let action: AgentAction | null = generated.toolCalls?.[0]
    ? toAction(generated.toolCalls[0])
    : generated.toolCall
    ? toAction(generated.toolCall)
    : nativeToolCalls && raw.trim()
      ? { type: "final_answer", answer: raw.trim() }
      : tryParse(parser, raw, knownTools);

  if (action === null) {
    await appendMessage(history, { role: "assistant", content: raw, usage: generated.usage }, opts.onMessageAppended);
    for (let attempt = 0; attempt < parseRetry && action === null; attempt += 1) {
      throwIfAborted(opts.signal);
      continueReason = "parse_retry";
      await appendMessage(history, {
        role: "tool",
        name: "parser",
        content: "解析失败：请严格按约定只输出一个 JSON 对象（thought / action / action_input）。",
      }, opts.onMessageAppended);
      generated = await generateOnce(opts.generate, onEvent, opts.signal);
      raw = generated.raw;
      await appendMessage(history, { role: "assistant", content: raw, usage: generated.usage }, opts.onMessageAppended);
      action = generated.toolCalls?.[0]
        ? toAction(generated.toolCalls[0])
        : generated.toolCall
        ? toAction(generated.toolCall)
        : nativeToolCalls && raw.trim()
          ? { type: "final_answer", answer: raw.trim() }
          : tryParse(parser, raw, knownTools);
    }
    if (action === null) {
      return { action: null, raw, usage: generated.usage, requestId: generated.requestId, finalAnswerText: "连续解析失败，终止任务。", continueReason };
    }
  } else {
    await appendMessage(history, {
      role: "assistant",
      content: raw,
      usage: generated.usage,
      ...(generated.reasoning ? { reasoning: generated.reasoning } : {}),
      requestId: generated.requestId,
      ...(generated.toolCalls?.length ? { toolCalls: generated.toolCalls.map((call) => ({ callId: call.callId, name: call.name, input: call.input })) } : generated.toolCall ? { toolCalls: [{ callId: generated.toolCall.callId, name: generated.toolCall.name, input: generated.toolCall.input }] } : {}),
    }, opts.onMessageAppended);
  }

  if (action.type === "final_answer") return { action, raw, usage: generated.usage, requestId: generated.requestId, continueReason };

  const toolAction = action.type === "tool_call" ? action : null;
  const calls = generated.toolCalls?.length ? generated.toolCalls : [{ callId: toolAction?.callId ?? generated.toolCall?.callId ?? createCallId(), name: toolAction?.toolName ?? "", input: toolAction?.toolInput ?? {} }];
  const executeCall = async (call: NativeToolCall) => {
    const candidate = toAction(call) as Extract<AgentAction, { type: "tool_call" }>;
    const callId = candidate.callId ?? createCallId();
    const withId = { ...candidate, callId } as AgentAction & { type: "tool_call" };
    await opts.onToolCallStarted?.({ callId, name: withId.toolName, input: withId.toolInput });
    onEvent?.({ type: "tool_use_started", toolName: withId.toolName, callId });
    let result = await executor.execute(withId, ctx, { callId, onEvent, signal: opts.signal });
    result = await opts.onToolCallCompleted?.({ callId, result }) ?? result;
    onEvent?.({ type: "tool_use_completed", toolName: withId.toolName, isError: result.isError === true });
    return { action: withId, result };
  };
  const completed: Array<{ action: Extract<AgentAction, { type: "tool_call" }>; result: ToolResult }> = [];
  let index = 0;
  while (index < calls.length) {
    if (ctx.registry.isParallelizable(calls[index].name)) {
      const batch: NativeToolCall[] = [];
      while (index < calls.length && ctx.registry.isParallelizable(calls[index].name)) batch.push(calls[index++]);
      completed.push(...await Promise.all(batch.map(executeCall)));
    } else {
      completed.push(await executeCall(calls[index++]));
    }
  }
  for (const entry of completed) await appendMessage(history, { role: "tool", name: entry.action.toolName, content: entry.result.output, toolCallId: entry.action.callId }, opts.onMessageAppended);
  const observation = completed[0]?.result;
  return {
    action: completed[0]?.action ?? action,
    raw,
    observation,
    toolCalls: calls,
    toolResults: completed.map((entry) => entry.result),
    usage: generated.usage,
    requestId: generated.requestId,
    reasoning: generated.reasoning,
    finishReason: generated.finishReason,
    continueReason: completed.some((entry) => entry.result.isError) ? "tool_error_recoverable" : "normal",
  };
}

async function appendMessage(history: Message[], message: Message, onAppended?: (message: Message) => Promise<Message | void>): Promise<void> {
  const persisted = await onAppended?.(message);
  history.push(structuredClone(persisted ?? message));
}

/** @deprecated 使用 runStep；该别名仅保留旧调用方兼容。 */
export const runTurn = runStep;
export type TurnResult = StepResult;
export type TurnOptions = StepOptions;

function tryParse(parser: OutputParser, raw: string, knownTools: Set<string>): AgentAction | null {
  try {
    return parser.parse(raw, knownTools);
  } catch {
    return null;
  }
}

async function generateOnce(
  generate: () => AsyncIterable<ModelEvent>,
  onEvent?: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<{ raw: string; usage?: Usage; requestId?: RequestId; toolCall?: NativeToolCall; toolCalls?: NativeToolCall[]; continueReason?: ContinueReason; finishReason?: string; reasoning?: string }> {
  throwIfAborted(signal);
  onEvent?.({ type: "stream_start" });
  let full = "";
  let usage: Usage | undefined;
  let requestId: RequestId | undefined;
  let continueReason: ContinueReason | undefined;
  let finishReason: string | undefined;
  let reasoning = "";
  const calls = new Map<CallId, { name: string; input?: unknown }>();
  for await (const event of generate()) {
    throwIfAborted(signal);
    onEvent?.({ type: "model_event", event });
    switch (event.type) {
      case "response_started":
        requestId = event.requestId;
        break;
      case "text_delta":
        full += event.text;
        onEvent?.({ type: "stream_delta", delta: event.text });
        break;
      case "reasoning_delta":
        reasoning += event.text;
        break;
      case "tool_call_started":
        calls.set(event.callId, { name: event.name });
        break;
      case "tool_call_completed": {
        const call = calls.get(event.callId);
        if (call) call.input = event.input;
        else calls.set(event.callId, { name: "", input: event.input });
        break;
      }
      case "usage":
        usage = event.usage;
        break;
      case "transport_warning":
        if (event.recoverable) continueReason = "transport_fallback";
        break;
      case "response_completed":
        finishReason = event.finishReason;
        break;
      default:
        break;
    }
  }
  const toolCalls = [...calls.entries()].filter(([, call]) => call.name).map(([callId, call]) => ({ callId, name: call.name, input: call.input ?? {} }));
  return { raw: full, usage, requestId, toolCall: toolCalls[0], toolCalls, continueReason, finishReason, reasoning: reasoning || undefined };
}

interface NativeToolCall {
  callId: CallId;
  name: string;
  input: unknown;
}

function toAction(call: NativeToolCall): AgentAction {
  if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)) {
    return { type: "tool_call", toolName: call.name, toolInput: {}, callId: call.callId };
  }
  return { type: "tool_call", toolName: call.name, toolInput: call.input as Record<string, unknown>, callId: call.callId };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Turn 已取消");
}
