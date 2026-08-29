import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ToolExecutionPreview } from "../tools/preview.js";

export type ApprovalScope = "once" | "session";

export interface ApprovalRequest {
  requestId: string;
  preview: ToolExecutionPreview;
  permissionFingerprint: string;
}

export interface ApprovalResult {
  approved: boolean;
  scope: ApprovalScope;
  approvedBy: "user" | "policy" | "test";
  resolvedAt: number;
}

export interface ApprovalBroker {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult>;
}

export class StaticApprovalBroker implements ApprovalBroker {
  readonly requests: ApprovalRequest[] = [];

  constructor(
    private response: boolean | ((request: ApprovalRequest) => boolean | Promise<boolean>) = false,
    private scope: ApprovalScope = "once",
  ) {}

  async request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult> {
    if (signal.aborted) throw signal.reason ?? new Error("审批已取消");
    this.requests.push(request);
    const approved = typeof this.response === "function" ? await this.response(request) : this.response;
    return { approved, scope: this.scope, approvedBy: "test", resolvedAt: Date.now() };
  }
}

export class CliApprovalBroker implements ApprovalBroker {
  private sessionApprovals = new Set<string>();

  async request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult> {
    const rule = approvalRule(request);
    if (this.sessionApprovals.has(rule)) {
      return { approved: true, scope: "session", approvedBy: "user", resolvedAt: Date.now() };
    }
    if (!stdin.isTTY || !stdout.isTTY) {
      return { approved: false, scope: "once", approvedBy: "policy", resolvedAt: Date.now() };
    }

    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await rl.question("批准？[y] 本次 / [s] 本会话同类操作 / [n] 拒绝: ", { signal })).trim().toLowerCase();
      const approved = answer === "y" || answer === "yes" || answer === "s" || answer === "session";
      const scope: ApprovalScope = answer === "s" || answer === "session" ? "session" : "once";
      if (approved && scope === "session") this.sessionApprovals.add(rule);
      return { approved, scope, approvedBy: "user", resolvedAt: Date.now() };
    } finally {
      rl.close();
    }
  }
}

function approvalRule(request: ApprovalRequest): string {
  return `${request.preview.toolName}:${request.preview.risk}`;
}
