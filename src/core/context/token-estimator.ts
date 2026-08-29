import type { Message, Usage } from "../../types.js";

const MESSAGE_OVERHEAD = 4;

export function roughTokenCount(value: string | Message | Message[]): number {
  if (typeof value === "string") return estimateTextTokens(value);
  if (Array.isArray(value)) return value.reduce((total, message) => total + messageTokenCount(message), 0);
  return messageTokenCount(value);
}

export function tokenCountWithAnchor(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const usage = messages[index].usage;
    if (usage) return usage.totalTokens + roughTokenCount(messages.slice(index + 1));
  }
  return roughTokenCount(messages);
}

export function messageTokenCount(message: Message): number {
  return estimateTextTokens(message.content) + (message.name ? estimateTextTokens(message.name) : 0) + MESSAGE_OVERHEAD;
}

export function getUsage(message: Message): Usage | undefined {
  return message.usage;
}

export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    tokens += isCjk(code) ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}
