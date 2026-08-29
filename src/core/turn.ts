import type {
  AgentAction,
  AgentContext,
  Message,
  ModelStreamEvent,
  ToolResult,
  Usage,
} from "../types.js";
import type { AgentEvent } from "./events.js";
import { Executor } from "./executor.js";
import { OutputParser } from "./output-parser.js";

export interface TurnResult {
  action: AgentAction | null;
  raw: string;
  observation?: ToolResult;
  finalAnswerText?: string;
  usage?: Usage;
}

export interface TurnOptions {
  history: Message[];
  generate: () => AsyncGenerator<ModelStreamEvent>;
  parser: OutputParser;
  knownTools: Set<string>;
  executor: Executor;
  ctx: AgentContext;
  parseRetry: number;
  onEvent?: (e: AgentEvent) => void;
}

export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const { history, parser, knownTools, executor, ctx, parseRetry, onEvent } = opts;
  let generated = await generateOnce(opts.generate, onEvent);
  let raw = generated.raw;
  let action: AgentAction | null = tryParse(parser, raw, knownTools);

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
      action = tryParse(parser, raw, knownTools);
    }
    if (action === null) {
      return { action: null, raw, usage: generated.usage, finalAnswerText: "连续解析失败，终止任务。" };
    }
  } else {
    history.push({ role: "assistant", content: raw, usage: generated.usage });
  }

  if (action.type === "final_answer") return { action, raw, usage: generated.usage };

  const callId = `${action.toolName}-${Date.now()}`;
  onEvent?.({ type: "tool_use_started", toolName: action.toolName, callId });
  const observation = await executor.execute(action, ctx, { callId, onEvent });
  onEvent?.({
    type: "tool_use_completed",
    toolName: action.toolName,
    isError: observation.isError === true,
  });
  history.push({ role: "tool", name: action.toolName, content: observation.output });
  return { action, raw, observation, usage: generated.usage };
}

function tryParse(parser: OutputParser, raw: string, knownTools: Set<string>): AgentAction | null {
  try {
    return parser.parse(raw, knownTools);
  } catch {
    return null;
  }
}

async function generateOnce(
  generate: () => AsyncGenerator<ModelStreamEvent>,
  onEvent?: (e: AgentEvent) => void,
): Promise<{ raw: string; usage?: Usage }> {
  onEvent?.({ type: "stream_start" });
  let full = "";
  let usage: Usage | undefined;
  for await (const event of generate()) {
    if (event.type === "text_delta") {
      full += event.text;
      onEvent?.({ type: "stream_delta", delta: event.text });
    } else if (event.type === "done") {
      if (event.raw) full = event.raw;
      usage = event.usage;
    }
  }
  return { raw: full, usage };
}
