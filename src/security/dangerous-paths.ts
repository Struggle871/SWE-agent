/**
 * 危险文件/目录保护（对齐 4.4.3）。
 * 编辑/写入类工具不得修改敏感路径（如 .git、.env、配置文件等），bypass 也不应放行。
 * Phase 3 落地为「工具/执行器入口直接拒绝」；后续 Phase 4 会将其并入 PermissionManager 的 ask/deny 决策。
 */

/** 敏感路径前缀/文件名（按路径段匹配，防止误伤如 .github、.env.example） */
const DANGEROUS_FILES = [
  ".git",
  ".gitignore",
  ".bashrc",
  ".zshrc",
  ".env",
  ".claude/settings.json",
  ".codex/config.toml",
  "package-lock.json",
];

/** 编辑/写入类工具：受危险路径保护约束 */
const EDIT_TOOLS = new Set(["edit_file", "write_file", "apply_patch"]);

export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

export function isWriteTool(toolName: string): boolean {
  return isEditTool(toolName);
}

/** 归一化路径分隔符，并去掉开头的 ./，便于统一匹配 */
function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * 判断目标路径是否命中敏感文件/目录。
 * @param toolName 工具名
 * @param input 工具入参（取 path 字段）
 * @returns 命中时返回拦截提示，否则返回 null
 */
export function checkDangerousPath(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (!isEditTool(toolName)) return null;
  const p = String(input?.path ?? "").trim();
  if (!p) return null;

  const norm = normalize(p);
  const segments = norm.split("/").filter(Boolean);

  for (const danger of DANGEROUS_FILES) {
    const d = normalize(danger);
    // 多段敏感路径（如 .claude/settings.json）：尾部匹配
    if (d.includes("/")) {
      if (norm === d || norm.endsWith("/" + d)) return `拒绝修改敏感路径 ${p}`;
      continue;
    }
    // 单段敏感路径（如 .git、.env）：匹配任意路径段
    if (segments.includes(d)) return `拒绝修改敏感路径 ${p}`;
  }
  return null;
}
