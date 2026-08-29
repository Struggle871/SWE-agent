import fs from "node:fs/promises";
import path from "node:path";
import type { AgentContext, ToolResult } from "../types.js";
import type { Tool } from "./types.js";
import { resolveInWorkspace } from "./paths.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".cache"]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".pdf", ".zip", ".gz", ".tgz",
  ".tar", ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".woff", ".woff2",
  ".ttf", ".otf", ".mp3", ".mp4", ".mov", ".avi", ".webp",
]);

async function walk(dir: string, onFile: (file: string) => Promise<boolean> | boolean): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, onFile);
    } else if (e.isFile()) {
      if ((await onFile(full)) === false) return;
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map(escapeRegExp).join(".*") + "$");
}

function isTextFile(p: string): boolean {
  return !BINARY_EXTS.has(path.extname(p).toLowerCase());
}

export const searchFilesTool: Tool = {
  name: "search_files",
  isReadOnly: true,
  description: "按文件名模式（glob，如 *.ts）在工作目录中搜索文件",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "文件名 glob，如 *.ts 或 test*" },
      path: { type: "string", description: "相对工作目录的起始路径，默认根目录" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const pattern = String(input.pattern ?? "*");
    const re = globToRegExp(pattern);
    const start = await resolveInWorkspace(ctx, String(input.path ?? "."));
    const matches: string[] = [];
    await walk(start, (file) => {
      if (re.test(path.basename(file))) {
        matches.push(path.relative(ctx.workspaceRoot, file));
      }
      return true;
    });
    return { toolName: "search_files", output: matches.slice(0, 200).join("\n") || "（无匹配）" };
  },
};

export const searchContentTool: Tool = {
  name: "search_content",
  isReadOnly: true,
  description: "在文本文件中按正则搜索内容，返回 file:line:content",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      path: { type: "string", description: "相对工作目录的起始路径，默认根目录" },
      maxResults: { type: "number", description: "最大返回条数，默认 50" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const pattern = String(input.pattern ?? "");
    const maxResults = typeof input.maxResults === "number" ? input.maxResults : 50;
    const re = new RegExp(pattern, "g");
    const start = await resolveInWorkspace(ctx, String(input.path ?? "."));
    const results: string[] = [];

    await walk(start, async (file) => {
      if (results.length >= maxResults) return false;
      if (!isTextFile(file)) return true;

      let content: string;
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        return true;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          results.push(`${path.relative(ctx.workspaceRoot, file)}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
          if (results.length >= maxResults) return false;
        }
      }
      return true;
    });

    return { toolName: "search_content", output: results.join("\n") || "（无匹配）" };
  },
};
