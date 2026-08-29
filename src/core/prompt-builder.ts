import type { AgentConfig, CompletedTaskSummary, Message, Task } from "../types.js";
import type { Tool } from "../tools/types.js";

const MESSAGE_OVERHEAD = 4; // 每条消息的角色/分隔符开销（估算）

export class PromptBuilder {
  build(opts: {
    messages: Message[];
    currentTask?: Task;
    completedTasks?: CompletedTaskSummary[];
    workingMemory?: Record<string, unknown>;
    agentMemories?: string;
    tools: Tool[];
    config: AgentConfig;
  }): Message[] {
    const { messages, currentTask, completedTasks, workingMemory, agentMemories, tools, config } = opts;

    const systemContent = this.buildSystemPrompt(tools, currentTask, completedTasks, workingMemory, agentMemories);
    // system 提示本身也计入上下文预算
    const systemTokens = estimateTokens(systemContent) + MESSAGE_OVERHEAD;
    const history = truncateHistory(messages, config.maxContextTokens, systemTokens);

    return [{ role: "system", content: systemContent }, ...history];
  }

  private buildSystemPrompt(
    tools: Tool[],
    task?: Task,
    completedTasks?: CompletedTaskSummary[],
    workingMemory?: Record<string, unknown>,
    agentMemories?: string,
  ): string {
    const toolList = tools
      .map((t) => `- ${t.name}: ${t.description}\n  参数: ${JSON.stringify(t.parameters)}`)
      .join("\n");

    const taskLine = task ? task.description : "（无）";

    const sections: string[] = [
      "你是 SWE Agent，需要完成给定的软件工程任务。",
      "",
      "## 可用工具",
      toolList || "（无）",
      "",
      "## 输出格式",
      "每一步必须只输出一个 JSON 对象，不要输出任何多余文本：",
      '{"thought": "<一句话说明这一步要做什么>", "action": "<工具名或 final_answer>", "action_input": { ... }}',
      "",
      "## 规则",
      "1. 每一步只能调用一个工具。",
      "2. 根据工具返回的观察结果逐步推进。",
      "3. 当你已经得到最终结论时，使用 final_answer 结束。",
      "4. 编辑或写入文件前，必须先使用 read_file 读取目标文件的最新内容；禁止凭猜测修改未读取的文件。",
      "",
      "## 当前子任务",
      taskLine,
    ];

    // 项目记忆（CLAUDE.md / AGENTS.md，对齐 Claude Code / Codex 的注入顺序）
    if (agentMemories && agentMemories.trim()) {
      sections.push("", "## 项目记忆", agentMemories.trim());
    }

    // 已完成任务摘要
    if (completedTasks && completedTasks.length > 0) {
      sections.push("", "## 已完成任务");
      for (const c of completedTasks) {
        sections.push(`- ${c.description}：${c.result}`);
      }
    }

    // 工作记忆
    if (workingMemory && Object.keys(workingMemory).length > 0) {
      sections.push("", "## 工作记忆");
      for (const [k, v] of Object.entries(workingMemory)) {
        sections.push(`- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
      }
    }

    return sections.join("\n");
  }
}

// CJK 字符按 1 token 计，其余字符按 4 字符 ≈ 1 token 计
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    tokens += isCJKChar(code) ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

function isCJKChar(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function messageTokens(m: Message): number {
  return estimateTokens(m.content) + (m.name ? estimateTokens(m.name) : 0) + MESSAGE_OVERHEAD;
}

interface Turn {
  messages: Message[];
  tokens: number;
}

function truncateHistory(messages: Message[], maxContextTokens: number, systemTokens: number): Message[] {
  const budget = Math.max(0, maxContextTokens - systemTokens);

  const firstAssistant = messages.findIndex((m) => m.role === "assistant");
  const prefix = firstAssistant === -1 ? messages : messages.slice(0, firstAssistant);
  const rest = firstAssistant === -1 ? [] : messages.slice(firstAssistant);

  const turns: Turn[] = [];
  for (const m of rest) {
    if (m.role === "assistant" || turns.length === 0) {
      turns.push({ messages: [m], tokens: messageTokens(m) });
    } else {
      const last = turns[turns.length - 1];
      last.messages.push(m);
      last.tokens += messageTokens(m);
    }
  }

  const prefixTokens = prefix.reduce((sum, m) => sum + messageTokens(m), 0);
  let total = prefixTokens + turns.reduce((sum, t) => sum + t.tokens, 0);

  let dropped = 0;
  while (total > budget && turns.length > 0) {
    total -= turns[0].tokens;
    turns.shift();
    dropped += 1;
  }

  if (dropped > 0) {
    console.warn(`[prompt-builder] 上下文超预算：已丢弃最早的 ${dropped} 轮消息，剩余 ${total}/${budget} tokens。`);
  } else if (total > budget) {
    console.warn(`[prompt-builder] 警告：仅任务描述本身（${total} tokens）已超过预算（${budget} tokens），无法继续截断。`);
  }

  return [...prefix, ...turns.flatMap((t) => t.messages)];
}

