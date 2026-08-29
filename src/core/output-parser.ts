import type { AgentAction } from "../types.js";

export class ParseError extends Error {
  constructor(
    public raw: string,
    message = "无法解析模型输出",
  ) {
    super(message);
    this.name = "ParseError";
  }
}

export class OutputParser {
  parse(raw: string, knownTools: Set<string>): AgentAction {
    const text = raw.trim();

    // 1) 先尝试 JSON：只有当 JSON 里确实包含 action 字段时才采纳，
    //    否则（例如 ReAct 文本里夹带的 action_input JSON）回退到 ReAct。
    const jsonText = extractJsonBlock(text);
    if (jsonText) {
      const obj = tryParseJson(jsonText);
      if (obj && typeof obj.action === "string") {
        return this.fromObject(obj, knownTools, text);
      }
    }

    // 2) 再尝试 ReAct 文本格式
    const react = parseReAct(text, knownTools);
    if (react) return react;

    throw new ParseError(raw);
  }

  private fromObject(obj: Record<string, unknown>, knownTools: Set<string>, raw: string): AgentAction {
    const action = (obj.action as string).trim();
    const thought = typeof obj.thought === "string" ? obj.thought : undefined;
    const rawInput = obj.action_input ?? obj.actionInput;

    if (action === "final_answer") {
      if (typeof rawInput === "string" && rawInput) {
        return { type: "final_answer", thought, answer: rawInput };
      }
      const input = (rawInput ?? {}) as Record<string, unknown>;
      return { type: "final_answer", thought, answer: pickAnswer(input, obj) };
    }

    if (!knownTools.has(action)) throw new ParseError(raw, `未知 action: ${action}`);
    const input = (rawInput ?? {}) as Record<string, unknown>;
    return { type: "tool_call", thought, toolName: action, toolInput: input };
  }
}

function pickAnswer(input: Record<string, unknown>, obj: Record<string, unknown>): string {
  for (const key of ["answer", "result", "response", "output", "conclusion"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  for (const key of ["answer", "result", "response", "output", "conclusion"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return JSON.stringify(input);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function extractJsonBlock(text: string): string | null {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  if (t.startsWith("{")) return extractBalanced(t);
  const start = t.indexOf("{");
  if (start === -1) return null;
  return extractBalanced(t.slice(start));
}

function extractBalanced(s: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}

function parseReAct(text: string, knownTools: Set<string>): AgentAction | null {
  const thought = text.match(/Thought\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:Action|Final Answer)\s*[:：]|$)/i)?.[1]?.trim();

  const finalAnswer = text.match(/Final\s+Answer\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:Thought|Action)\s*[:：]|$)/i)?.[1]?.trim();
  if (finalAnswer !== undefined) {
    return { type: "final_answer", thought, answer: finalAnswer };
  }

  const actionMatch = text.match(/Action\s*[:：]\s*(\S+)/i);
  if (!actionMatch) return null;

  const action = actionMatch[1].trim();
  const inputRaw =
    text.match(/Action\s*Input\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:Thought|Action|Final Answer)\s*[:：]|$)/i)?.[1]?.trim() ?? "";

  if (action.toLowerCase() === "final_answer") {
    return { type: "final_answer", thought, answer: inputRaw };
  }

  if (!knownTools.has(action)) return null;

  let toolInput: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(inputRaw || "{}");
    if (parsed && typeof parsed === "object") toolInput = parsed as Record<string, unknown>;
  } catch {
    toolInput = { command: inputRaw };
  }
  return { type: "tool_call", thought, toolName: action, toolInput };
}