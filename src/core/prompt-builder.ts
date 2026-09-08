import type { AgentConfig, CompletedTaskSummary, Message, Task } from "../types.js";
import type { ToolSpec } from "../tools/types.js";
import { qualifiedName } from "../tools/registry.js";

export class PromptBuilder {
  build(opts: {
    messages: readonly Message[];
    currentTask?: Task;
    completedTasks?: CompletedTaskSummary[];
    workingMemory?: Record<string, unknown>;
    agentMemories?: string;
    tools: ToolSpec[];
    config: AgentConfig;
    nativeToolCalls?: boolean;
    contextualFragments?: readonly { role: "user" | "developer"; text: string }[];
  }): Message[] {
    const { messages, currentTask, completedTasks, workingMemory, agentMemories, tools, nativeToolCalls = false } = opts;
    const systemContent = this.systemPrompt(tools, currentTask, completedTasks, workingMemory, agentMemories, nativeToolCalls);
    const fragments = (opts.contextualFragments ?? []).map((fragment) => ({ role: fragment.role, content: fragment.text } as Message));
    return [{ role: "system", content: systemContent }, ...fragments, ...messages.map((message) => structuredClone(message))];
  }

  systemPrompt(
    tools: ToolSpec[],
    task?: Task,
    completedTasks?: CompletedTaskSummary[],
    workingMemory?: Record<string, unknown>,
    agentMemories?: string,
    nativeToolCalls = false,
  ): string {
    const toolList = tools
      .map((t) => `- ${qualifiedName(t)}: ${t.description}${nativeToolCalls ? "" : `\n  参数: ${JSON.stringify(t.parameters)}`}`)
      .join("\n");

    const taskLine = task ? task.description : "（无）";

    const sections: string[] = [
      "你是 SWE Agent，需要完成给定的软件工程任务。",
      "",
      "## 可用工具",
      toolList || "（无）",
      "",
      "## 规则",
      "1. 根据工具返回的观察结果逐步推进。",
      "2. 当你已经得到最终结论时结束。",
      "3. 编辑或写入文件前，必须先使用 read_file 读取目标文件的最新内容；禁止凭猜测修改未读取的文件。",
      "",
      "## 当前子任务",
      taskLine,
    ];

    if (!nativeToolCalls) {
      sections.splice(2, 0, "## 输出格式", "每一步必须只输出一个 JSON 对象，不要输出任何多余文本：", '{"thought": "<一句话说明这一步要做什么>", "action": "<工具名或 final_answer>", "action_input": { ... }}', "");
      sections.splice(7, 0, "每一步只能调用一个工具。", "");
    }

    // 项目记忆（CLAUDE.md / AGENTS.md，对齐 Claude Code / Codex 的注入顺序）
    if (!nativeToolCalls && agentMemories && agentMemories.trim()) {
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

