import type {
  AgentAction,
  AgentContext,
  Message,
  ToolResult,
  Usage,
} from "../types.js";
import type { AgentEvent } from "./events.js";
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
  onEvent?: (e: AgentEvent) => void;
}

export async function runStep(opts: StepOptions): Promise<StepResult> {
  const { history, parser, knownTools, executor, ctx, parseRetry, nativeToolCalls = false, onEvent } = opts;
  let generated = await generateOnce(opts.generate, onEvent);
  let raw = generated.raw;
  let action: AgentAction | null = generated.toolCall
    ? toAction(generated.toolCall)
    : nativeToolCalls && raw.trim()
      ? { type: "final_answer", answer: raw.trim() }
      : tryParse(parser, raw, knownTools);

  if (action === null) {
    history.push({ role: "assistant", content: raw, usage: generated.usage });
    for (let attempt = 0; attempt < parseRetry && action === null; attempt += 1) {
      history.push({
        role: "tool",
        name: "parser",
        content: "解析失败：请严格按约定只输出一个 JSON 对象（thought / action / action_input）。",
      });
      generated = await generateOnce(opts.generate, onEvent);
      raw = generated.raw;
      history.push({ role: "assistant", content: raw, usage: generated.usage });
      action = generated.toolCall
        ? toAction(generated.toolCall)
        : nativeToolCalls && raw.trim()
          ? { type: "final_answer", answer: raw.trim() }
          : tryParse(parser, raw, knownTools);
    }
    if (action === null) {
      return { action: null, raw, usage: generated.usage, requestId: generated.requestId, finalAnswerText: "连续解析失败，终止任务。" };
    }
  } else {
    history.push({
      role: "assistant",
      content: raw,
      usage: generated.usage,
      requestId: generated.requestId,
      ...(generated.toolCall ? { toolCalls: [{ callId: generated.toolCall.callId, name: generated.toolCall.name, input: generated.toolCall.input }] } : {}),
    });
  }

  if (action.type === "final_answer") return { action, raw, usage: generated.usage, requestId: generated.requestId };

  const callId = action.callId ?? generated.toolCall?.callId ?? createCallId();
  action = { ...action, callId };
  onEvent?.({ type: "tool_use_started", toolName: action.toolName, callId });
  const observation = await executor.execute(action, ctx, { callId, onEvent });
  onEvent?.({
    type: "tool_use_completed",
    toolName: action.toolName,
    isError: observation.isError === true,
  });
  history.push({ role: "tool", name: action.toolName, content: observation.output, toolCallId: callId });
  return { action, raw, observation, usage: generated.usage, requestId: generated.requestId };
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
): Promise<{ raw: string; usage?: Usage; requestId?: RequestId; toolCall?: NativeToolCall }> {
  onEvent?.({ type: "stream_start" });
  let full = "";
  let usage: Usage | undefined;
  let requestId: RequestId | undefined;
  const calls = new Map<CallId, { name: string; input?: unknown }>();
  for await (const event of generate()) {
    onEvent?.({ type: "model_event", event });
    switch (event.type) {
      case "response_started":
        requestId = event.requestId;
        break;
      case "text_delta":
        full += event.text;
        onEvent?.({ type: "stream_delta", delta: event.text });
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
      default:
        break;
    }
  }
  const firstCall = [...calls.entries()][0];
  const toolCall = firstCall && firstCall[1].name
    ? { callId: firstCall[0], name: firstCall[1].name, input: firstCall[1].input ?? {} }
    : undefined;
  return { raw: full, usage, requestId, toolCall };
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
