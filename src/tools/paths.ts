import type { AgentContext } from "../types.js";
import type { WorkspaceAccess } from "../security/workspace-policy.js";

/**
 * 将相对路径解析为工作目录内的绝对路径。
 * 若解析结果越出 workspaceRoot 则抛出异常（用于 read/write/edit 等文件工具的边界保护）。
 */
export async function resolveInWorkspace(ctx: AgentContext, p: string, access: WorkspaceAccess = "read"): Promise<string> {
  const target = await ctx.workspacePolicy.resolve(p, access);
  if (access === "write") ctx.workspacePolicy.assertWritableTarget(target);
  return target.canonicalPath;
}
