import fs from "node:fs/promises";
import path from "node:path";
import type { AgentContext, ToolResult } from "../types.js";
import type { Tool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";
import { atomicWriteFile } from "./atomic-write.js";

export const readFileTool: Tool = {
  name: "read_file",
  isReadOnly: true,
  description: "读取文件内容，可指定行区间（startLine/endLine，从 1 开始）",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径" },
      startLine: { type: "number", description: "起始行（含）" },
      endLine: { type: "number", description: "结束行（含）" },
    },
    required: ["path"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const p = await resolveInWorkspace(ctx, String(input.path ?? ""));
    const content = await fs.readFile(p, "utf8");

    // 记录文件状态，供「编辑前必须读取」校验
    await ctx.fileStateCache.markRead(p);

    const lines = content.split("\n");
    const start = typeof input.startLine === "number" ? Math.max(1, input.startLine) : 1;
    const end = typeof input.endLine === "number" ? Math.min(lines.length, input.endLine) : lines.length;
    const sliced = lines.slice(start - 1, end).join("\n");
    const header = `（共 ${lines.length} 行，显示 ${start}-${end} 行）\n`;
    ctx.workingMemory["lastReadFile"] = p;
    return { toolName: "read_file", output: header + sliced };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "写入（覆盖）文件内容；append 为 true 时追加；需先用 read_file 读取目标文件",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径" },
      content: { type: "string", description: "文件内容" },
      append: { type: "boolean", description: "是否追加", default: false },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const p = await resolveInWorkspace(ctx, String(input.path ?? ""), "write");

    // 编辑/写入前必须读取（read-before-edit；新建文件允许）
    const stale = await ctx.fileStateCache.assertFresh(p);
    if (stale) return { toolName: "write_file", output: stale, isError: true };

    const content = String(input.content ?? "");
    const previous = input.append === true ? await fs.readFile(p, "utf8").catch(() => "") : "";
    await atomicWriteFile(p, previous + content);

    // 记录写后状态，使同一文件上的连续写入/编辑无需重新读取
    await ctx.fileStateCache.markWritten(p);
    ctx.workingMemory["lastWrittenFile"] = p;
    return { toolName: "write_file", output: `已写入 ${p}（${Buffer.byteLength(content, "utf8")} 字节）` };
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  isReadOnly: true,
  description: "列出目录内容（名称与类型）",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的路径，默认根目录" },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const p = await resolveInWorkspace(ctx, String(input.path ?? "."));
    const entries = await fs.readdir(p, { withFileTypes: true });
    const lines = entries.map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`);
    return { toolName: "list_dir", output: lines.join("\n") || "（空目录）" };
  },
};
