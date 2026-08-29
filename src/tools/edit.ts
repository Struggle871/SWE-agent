import fs from "node:fs/promises";
import type { ToolResult } from "../types.js";
import type { Tool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";
import { atomicWriteFile } from "./atomic-write.js";

/**
 * edit_file：精确字符串替换（search-and-replace），对齐 Claude Code FileEditTool / Codex apply_patch。
 * - 要求 old_string 在文件中唯一，否则报错提示提供更多上下文（避免基于歧义做不精确编辑）。
 * - 支持 replace_all=true 一次性替换所有出现位置。
 * - 替换后做尾部空白裁剪（.md/.mdx 例外，两空格表示硬换行）。
 * - 写盘前做「危险路径保护 + 编辑前必须读取」校验。
 */
export const editFileTool: Tool = {
  name: "edit_file",
  description: "精确替换文件中的唯一字符串片段（old_string -> new_string）；需先用 read_file 读取目标文件",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径" },
      old_string: { type: "string", description: "文件中实际存在的精确字符串" },
      new_string: { type: "string", description: "替换后的字符串" },
      replace_all: { type: "boolean", description: "替换所有出现位置", default: false },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const p = await resolveInWorkspace(ctx, String(input.path ?? ""), "write");

    const oldStr = String(input.old_string ?? "");
    const newStr = normalizeNewString(p, String(input.new_string ?? ""));
    if (!oldStr) {
      return { toolName: "edit_file", output: "old_string 不能为空。", isError: true };
    }

    // 目标文件必须存在（edit 是修改既有文件，创建请用 write_file）
    try {
      await fs.access(p);
    } catch {
      return { toolName: "edit_file", output: `文件不存在，无法编辑：${p}（若要创建新文件请使用 write_file）。`, isError: true };
    }

    // 编辑前必须读取（read-before-edit）
    const stale = await ctx.fileStateCache.assertFresh(p);
    if (stale) return { toolName: "edit_file", output: stale, isError: true };

    let content: string;
    try {
      content = await fs.readFile(p, "utf8");
    } catch (e) {
      return { toolName: "edit_file", output: `读取文件失败: ${String(e)}`, isError: true };
    }

    const count = occurrences(content, oldStr);
    if (count === 0) {
      return {
        toolName: "edit_file",
        output: "old_string 未在文件中找到（可能已变化），请重新 read_file 获取最新内容。",
        isError: true,
      };
    }
    if (count > 1 && input.replace_all !== true) {
      return {
        toolName: "edit_file",
        output: `old_string 出现 ${count} 次，不唯一；请提供更多上下文使其唯一，或设置 replace_all=true。`,
        isError: true,
      };
    }

    // 使用函数替换器，避免 newStr 中的 $ 序列被当作替换模式展开（保证字面量精确替换）
    const next = input.replace_all === true ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr);
    await atomicWriteFile(p, next);

    // 记录写后状态，使同一文件上的连续编辑无需重新读取
    await ctx.fileStateCache.markWritten(p);
    ctx.workingMemory["lastWrittenFile"] = p;

    return { toolName: "edit_file", output: `已替换 ${p}（${input.replace_all === true ? count : 1} 处）` };
  },
};

/** 统计 oldStr 在 content 中的出现次数（非重叠） */
function occurrences(content: string, oldStr: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(oldStr, idx)) !== -1) {
    count += 1;
    idx += oldStr.length;
  }
  return count;
}

/** 尾部空白裁剪；.md/.mdx 例外（两空格表示硬换行） */
function normalizeNewString(p: string, s: string): string {
  if (/\.(md|mdx)$/i.test(p)) return s;
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}


