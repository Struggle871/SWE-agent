// CLAUDE.md / AGENTS.md 分层发现与合并注入（对齐 Claude Code CLAUDE.md、Codex AGENTS.md）

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// 停止向上查找的根标记（对齐 Codex project_root_markers）
const PROJECT_ROOT_MARKERS = [".git", ".hg", ".svn"];
const DEFAULT_BUDGET_BYTES = 8_000;

// 从 cwd 向上逐级查找记忆文件，最近层（最深层）优先
export function discoverAgentMemories(cwd: string): string[] {
  const found: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    const candidates = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
    const selected = candidates.map((name) => path.join(dir, name)).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (selected) found.unshift(selected);
    if (PROJECT_ROOT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

// 读取并合并记忆文件内容，按字节预算截断（超预算输出 warning 而非报错）
export function loadAgentMemories(cwd: string, budgetBytes: number = DEFAULT_BUDGET_BYTES): string {
  const files = discoverAgentMemories(cwd);
  if (files.length === 0) return "";

  const parts: string[] = [];
  let used = 0;
  for (const f of files) {
    const content = fs.readFileSync(f, "utf8");
    const header = `# 项目记忆（${path.relative(cwd, f) || path.basename(f)}）`;
    const block = `${header}\n${content}`;
    const bytes = Buffer.byteLength(block, "utf8");
    if (used + bytes > budgetBytes) {
      const remain = Math.max(0, budgetBytes - used);
      if (remain > 0) parts.push(new TextDecoder().decode(Buffer.from(block, "utf8").subarray(0, remain)));
      console.warn(`[agents-md] 项目记忆超过 ${budgetBytes} 字节预算，已截断：${f}`);
      break;
    }
    parts.push(block);
    used += bytes;
  }

  return parts.join("\n\n");
}

export interface AgentInstructionFragment { role: "user"; type: "agents_md.instructions"; source: string; text: string; hash: string; }
export function loadAgentInstructionFragments(cwd: string, budgetBytes = DEFAULT_BUDGET_BYTES): AgentInstructionFragment[] {
  const text = loadAgentMemories(cwd, budgetBytes);
  return text ? [{ role: "user", type: "agents_md.instructions", source: path.resolve(cwd), text, hash: createHash("sha256").update(text).digest("hex") }] : [];
}
