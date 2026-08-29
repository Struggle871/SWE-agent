import type { Message } from "../../types.js";
import { ToolResultStorage } from "./tool-result-storage.js";
import { messageTokenCount, tokenCountWithAnchor } from "./token-estimator.js";

export interface CompactionReport {
  persistedToolResults: number;
  clearedToolResults: number;
  collapsedTurns: number;
  summarized: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

export interface CompactionOptions {
  budgetTokens: number;
  systemTokens?: number;
  recentFiles?: string[];
  recentToolTurns?: number;
  collapseAfterTurns?: number;
}

export interface CompactionSummarizer {
  summarize(messages: Message[], options: CompactionOptions): Promise<Message[]>;
}

export class DeterministicCompactionSummarizer implements CompactionSummarizer {
  async summarize(messages: Message[]): Promise<Message[]> {
    const prefix = messages.filter((message) => message.role === "user" || message.role === "system");
    const summary = messages
      .filter((message) => message.role === "assistant" || message.role === "tool")
      .map((message) => `${message.role}${message.name ? `(${message.name})` : ""}: ${message.content.slice(0, 300)}`)
      .join("\n");
    return [...prefix, { role: "assistant", content: `[历史摘要]\n${summary.slice(0, 4_000)}` }];
  }
}

export class CompactionPipeline {
  constructor(
    private storage: ToolResultStorage,
    private summarizer: CompactionSummarizer = new DeterministicCompactionSummarizer(),
  ) {}

  async compact(messages: Message[], options: CompactionOptions): Promise<{ messages: Message[]; report: CompactionReport }> {
    const estimatedTokensBefore = tokenCountWithAnchor(messages);
    let current = [...messages];
    let persistedToolResults = 0;
    let clearedToolResults = 0;
    let collapsedTurns = 0;
    let summarized = false;

    const persisted = await this.persistLargeToolResults(current);
    current = persisted.messages;
    persistedToolResults = persisted.count;

    if (this.totalTokens(current) + (options.systemTokens ?? 0) > options.budgetTokens) {
      const cleared = this.clearOldToolResults(current, options.recentToolTurns ?? 3);
      current = cleared.messages;
      clearedToolResults = cleared.count;
    }

    if (this.totalTokens(current) + (options.systemTokens ?? 0) > options.budgetTokens) {
      const collapsed = this.collapseIdleTurns(current, options.collapseAfterTurns ?? 10);
      current = collapsed.messages;
      collapsedTurns = collapsed.count;
    }

    if (this.totalTokens(current) + (options.systemTokens ?? 0) > options.budgetTokens) {
      current = await this.summarizer.summarize(current, options);
      summarized = true;
    }

    current = this.restoreRecentFiles(current, options.recentFiles ?? []);
    const estimatedTokensAfter = tokenCountWithAnchor(current);

    return {
      messages: current,
      report: {
        persistedToolResults,
        clearedToolResults,
        collapsedTurns,
        summarized,
        estimatedTokensBefore,
        estimatedTokensAfter,
      },
    };
  }

  private async persistLargeToolResults(messages: Message[]): Promise<{ messages: Message[]; count: number }> {
    let count = 0;
    const result: Message[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "tool") {
        result.push(message);
        continue;
      }
      const compacted = await this.storage.persistIfLarge(message.name ?? "tool", `message-${index}`, message.content);
      if (compacted !== message.content) count += 1;
      result.push({ ...message, content: compacted });
    }
    return { messages: result, count };
  }

  private clearOldToolResults(messages: Message[], recentToolTurns: number): { messages: Message[]; count: number } {
    const toolIndexes = messages.map((message, index) => (message.role === "tool" ? index : -1)).filter((index) => index >= 0);
    const keep = new Set(toolIndexes.slice(-recentToolTurns));
    let count = 0;
    const result = messages.map((message, index) => {
      if (message.role !== "tool" || keep.has(index) || message.content.startsWith("[历史工具结果已清理")) return message;
      count += 1;
      return { ...message, content: "[历史工具结果已清理，保留工具调用记录]" };
    });
    return { messages: result, count };
  }

  private collapseIdleTurns(messages: Message[], thresholdTurns: number): { messages: Message[]; count: number } {
    const assistantIndexes = messages.map((message, index) => (message.role === "assistant" ? index : -1)).filter((index) => index >= 0);
    if (assistantIndexes.length <= thresholdTurns) return { messages, count: 0 };
    const cutoff = assistantIndexes[assistantIndexes.length - thresholdTurns];
    const firstAssistant = assistantIndexes[0];
    const prefix = messages.slice(0, firstAssistant);
    const old = messages.slice(firstAssistant, cutoff);
    const recent = messages.slice(cutoff);
    const summary = old
      .filter((message) => message.role === "assistant" || message.role === "tool")
      .map((message) => `${message.role}${message.name ? `(${message.name})` : ""}: ${message.content.slice(0, 160)}`)
      .join("\n");
    return {
      messages: [...prefix, { role: "assistant", content: `[较早轮次摘要]\n${summary.slice(0, 3_000)}` }, ...recent],
      count: Math.max(1, assistantIndexes.length - thresholdTurns),
    };
  }

  private restoreRecentFiles(messages: Message[], recentFiles: string[]): Message[] {
    const files = [...new Set(recentFiles.filter(Boolean))];
    if (files.length === 0) return messages;
    return [...messages, { role: "system", content: `最近操作文件：\n${files.map((file) => `- ${file}`).join("\n")}` }];
  }

  private totalTokens(messages: Message[]): number {
    return messages.reduce((total, message) => total + messageTokenCount(message), 0);
  }
}

