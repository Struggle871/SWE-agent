import type { ApprovalBroker, ApprovalRequest, ApprovalResult } from "../security/approval-broker.js";

interface PendingApproval { request: ApprovalRequest; resolve: (result: ApprovalResult) => void; reject: (error: unknown) => void }

/** JSON-RPC friendly approval broker. A turn may wait while a UI resolves the request. */
export class ServerApprovalBroker implements ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  async request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResult> {
    if (signal.aborted) throw signal.reason ?? new Error("审批已取消");
    return new Promise<ApprovalResult>((resolve, reject) => {
      const entry = { request, resolve, reject };
      this.pending.set(request.requestId, entry);
      const abort = () => entry.reject(signal.reason ?? new Error("审批已取消"));
      signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => signal.removeEventListener("abort", abort);
      const originalResolve = resolve;
      entry.resolve = (result) => { cleanup(); this.pending.delete(request.requestId); originalResolve(result); };
      const originalReject = reject;
      entry.reject = (error) => { cleanup(); this.pending.delete(request.requestId); originalReject(error); };
    });
  }
  list(): ApprovalRequest[] { return [...this.pending.values()].map(({ request }) => structuredClone(request)); }
  resolve(requestId: string, approved: boolean, scope: "once" | "session" = "once"): void {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`审批请求不存在或已结束: ${requestId}`);
    entry.resolve({ approved, scope, approvedBy: "user", resolvedAt: Date.now() });
  }
  rejectAll(reason = "审批 broker 已关闭"): void { for (const entry of this.pending.values()) entry.reject(new Error(reason)); }
}
