import type { ToolDecision, ToolRisk } from "../tools/preview.js";

export interface PermissionProfile {
  allowRead: boolean;
  askWrite: boolean;
  askExecute: boolean;
  allowNetwork: boolean;
}

export const CONSERVATIVE_PERMISSION_PROFILE: PermissionProfile = {
  allowRead: true,
  askWrite: true,
  askExecute: true,
  allowNetwork: false,
};

export class PermissionPolicy {
  constructor(readonly profile: PermissionProfile = CONSERVATIVE_PERMISSION_PROFILE) {}

  decide(risk: ToolRisk): { decision: ToolDecision; reasons: string[] } {
    if (risk === "read") return this.profile.allowRead
      ? { decision: "allow", reasons: ["只读工具自动允许"] }
      : { decision: "ask", reasons: ["当前权限配置要求审批只读工具"] };
    if (risk === "write") return this.profile.askWrite
      ? { decision: "ask", reasons: ["文件写入需要批准"] }
      : { decision: "allow", reasons: ["权限配置允许文件写入"] };
    if (risk === "network" && !this.profile.allowNetwork) {
      return { decision: "ask", reasons: ["网络访问需要批准"] };
    }
    if (risk === "destructive") return { decision: "ask", reasons: ["破坏性操作需要批准"] };
    return this.profile.askExecute
      ? { decision: "ask", reasons: ["命令执行需要批准"] }
      : { decision: "allow", reasons: ["权限配置允许命令执行"] };
  }

  fingerprint(): string {
    return JSON.stringify(this.profile);
  }
}
