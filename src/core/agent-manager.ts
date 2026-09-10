import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { AgentContext, AgentRunResult, Message } from "../types.js";
import { AgentSession } from "./agent-session.js";
import { MailboxStore, type MailboxMessage } from "./mailbox.js";
import { ShellSession } from "../tools/terminal.js";
import { WorktreeManager, type ManagedWorktree } from "./worktree-manager.js";
import { FileStateCache } from "./file-state-cache.js";
import { WorkspacePolicy } from "../security/workspace-policy.js";
import { DefaultCommandAnalyzer } from "../security/command-policy.js";
import { LocalSandboxProvider } from "../security/sandbox.js";
import { AuditTrail } from "../security/audit.js";
import type { AgentEvent } from "./events.js";

export type ChildAgentStatus = "starting" | "running" | "completed" | "failed" | "cancelled";
export interface ChildAgentInfo { id: string; parentSessionId?: string; taskId?: string; prompt: string; status: ChildAgentStatus; result?: string; error?: string; transcriptPath?: string; workspaceRoot?: string; worktree?: ManagedWorktree; startedAt: number; finishedAt?: number }

/** Owns local child sessions. Child contexts never share mutable workingMemory with the parent. */
export class AgentManager {
  private readonly children = new Map<string, { info: ChildAgentInfo; session: AgentSession; shell: ShellSession }>();
  private readonly recovered = new Map<string, ChildAgentInfo>();
  private readonly worktreePaths = new Map<string, string[]>();
  private readonly mailbox: MailboxStore;
  private readonly statePath: string;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly parent: AgentContext, private readonly transcriptRoot: string, private readonly onEvent?: (event: AgentEvent) => void, private readonly contextProvider?: () => readonly Message[]) {
    this.mailbox = new MailboxStore(path.join(transcriptRoot, "mailbox.jsonl"));
    this.statePath = path.join(transcriptRoot, "agents.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8")) as { agents?: ChildAgentInfo[] };
      for (const info of parsed.agents ?? []) {
        if (info.status === "starting" || info.status === "running") {
          info.status = "failed";
          info.error = "宿主进程在子 Agent 完成前退出；工具调用不会自动重放";
          info.finishedAt = Date.now();
        }
        this.recovered.set(info.id, info);
      }
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async spawn(prompt: string, parentSessionId?: string, options: { isolateWorkspace?: boolean; forkMode?: "none" | "all" | number; taskId?: string } = {}): Promise<ChildAgentInfo> {
    if (!prompt.trim()) throw new Error("子 Agent prompt 不能为空");
    const id = randomUUID();
    const startHook = await this.parent.hooks?.dispatch("SubagentStart", { agentId: id, parentSessionId, prompt }, this.parent);
    if (startHook?.blocked) throw new Error(startHook.reason ?? "SubagentStart hook blocked child agent");
    const worktree = options.isolateWorkspace ? await new WorktreeManager(path.join(this.transcriptRoot, "worktrees")).create(this.parent.workspaceRoot) : undefined;
    const workspaceRoot = worktree?.root ?? this.parent.workspaceRoot;
    const shell = new ShellSession(workspaceRoot);
    const workspacePolicy = await WorkspacePolicy.create({ readableRoots: [workspaceRoot] });
    const sandbox = new LocalSandboxProvider(workspaceRoot);
    const childContext: AgentContext = {
      ...this.parent, shell, workspaceRoot, workingMemory: {}, taskGraph: undefined, agentManager: undefined,
      config: { ...this.parent.config, workspaceRoot }, fileStateCache: new FileStateCache(), workspacePolicy,
      commandAnalyzer: new DefaultCommandAnalyzer(workspacePolicy, sandbox.capabilities().shellDialect),
      auditTrail: new AuditTrail(path.join(workspaceRoot, ".swe-agent", "audit.jsonl")), sandboxProvider: sandbox,
    };
    const initialMessages = selectForkMessages(this.contextProvider?.() ?? [], options.forkMode ?? "none");
    const session = new AgentSession(childContext, (event) => this.onEvent?.({ type: "subagent_event", agentId: id, event }), { transcriptRoot: path.join(this.transcriptRoot, "children"), initialMessages });
    const info: ChildAgentInfo = { id, parentSessionId, ...(options.taskId ? { taskId: options.taskId } : {}), prompt, status: "starting", transcriptPath: session.transcriptPath, workspaceRoot, ...(worktree ? { worktree } : {}), startedAt: Date.now() };
    this.children.set(id, { info, session, shell });
    this.onEvent?.({ type: "subagent_started", agentId: id, ...(parentSessionId ? { parentSessionId } : {}), prompt });
    await this.persist();
    void this.runChild(id);
    return { ...info };
  }

  async send(to: string, body: string, from = "parent"): Promise<MailboxMessage> {
    if (!this.children.has(to)) throw new Error(`子 Agent 不存在: ${to}`);
    const message = await this.mailbox.send(from, to, body);
    this.children.get(to)?.session.steer(body);
    return message;
  }

  async messages(recipient?: string): Promise<MailboxMessage[]> { return this.mailbox.list(recipient); }

  list(): ChildAgentInfo[] { return [...this.recovered.values(), ...[...this.children.values()].map(({ info }) => info)].map((info) => ({ ...info })); }
  get(id: string): ChildAgentInfo | undefined { const value = this.children.get(id)?.info ?? this.recovered.get(id); return value ? { ...value } : undefined; }

  async wait(id: string, timeoutMs = 120_000): Promise<ChildAgentInfo> {
    const child = this.children.get(id);
    if (!child) {
      const recovered = this.recovered.get(id);
      if (recovered && !["starting", "running"].includes(recovered.status)) return { ...recovered };
      throw new Error(`子 Agent 不存在: ${id}`);
    }
    const deadline = Date.now() + timeoutMs;
    while (["starting", "running"].includes(child.info.status) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (["starting", "running"].includes(child.info.status)) throw new Error(`等待子 Agent 超时: ${id}`);
    await this.persistQueue;
    return { ...child.info };
  }

  interrupt(id: string): void {
    const child = this.children.get(id);
    if (!child) throw new Error(`子 Agent 不存在: ${id}`);
    child.session.interrupt("父 Agent 取消子任务");
    child.info.status = "cancelled";
    this.cancelBoundTask(child.info, "父 Agent 取消子任务");
    void this.persist();
  }

  cancelAll(reason = "父 Agent 取消"): void {
    for (const child of this.children.values()) {
      if (["starting", "running"].includes(child.info.status)) {
        child.session.interrupt(reason);
        child.info.status = "cancelled";
        this.cancelBoundTask(child.info, reason);
      }
    }
    void this.persist();
  }

  async close(): Promise<void> {
    await Promise.all([...this.children.values()].map(async ({ info, session, shell }) => {
      session.interrupt("父 Agent 关闭");
      await session.close(); await shell.close();
      if (info.worktree) await new WorktreeManager(path.join(this.transcriptRoot, "worktrees")).remove(info.worktree).catch(() => undefined);
    }));
  }

  private async runChild(id: string): Promise<void> {
    const child = this.children.get(id);
    if (!child) return;
    child.info.status = "running";
    if (child.info.taskId) this.parent.taskGraph?.update(child.info.taskId, { status: "in_progress", ownerSessionId: child.session.sessionId, attempts: (this.parent.taskGraph.get(child.info.taskId)?.attempts ?? 0) + 1 });
    await this.persist();
    try {
      const result: AgentRunResult = await child.session.run(child.info.prompt);
      const cancelled = this.children.get(id)?.info.status === "cancelled" as ChildAgentStatus;
      if (!cancelled) {
        child.info.status = "completed";
        child.info.result = result.answer;
      }
      if (!cancelled && child.info.worktree) {
        const manager = new WorktreeManager(path.join(this.transcriptRoot, "worktrees"));
        const changed = await manager.changedPaths(child.info.worktree);
        this.worktreePaths.set(id, changed);
        const conflicts = [...this.worktreePaths.entries()].filter(([otherId]) => otherId !== id).flatMap(([, paths]) => changed.filter((item) => paths.includes(item)));
        if (conflicts.length > 0) {
          child.info.status = "failed";
          child.info.error = `并行 Agent 写入冲突: ${[...new Set(conflicts)].join(", ")}`;
          child.info.result = undefined;
        }
      }
      if (child.info.taskId && child.info.status === "completed") this.parent.taskGraph?.complete(child.info.taskId, child.info.result);
      if (child.info.taskId && child.info.status === "failed") this.parent.taskGraph?.fail(child.info.taskId, child.info.error ?? "子 Agent 失败");
    } catch (error) {
      child.info.status = this.children.get(id)?.info.status === "cancelled" ? "cancelled" : "failed";
      child.info.error = error instanceof Error ? error.message : String(error);
      if (child.info.taskId && child.info.status === "cancelled") this.cancelBoundTask(child.info, child.info.error);
      else if (child.info.taskId) this.parent.taskGraph?.fail(child.info.taskId, child.info.error);
    } finally {
      child.info.finishedAt = Date.now();
      const terminalStatus = ["completed", "failed", "cancelled"].includes(child.info.status) ? child.info.status as "completed" | "failed" | "cancelled" : "failed";
      this.onEvent?.({ type: "subagent_completed", agentId: id, status: terminalStatus, ...(child.info.result ? { result: child.info.result } : {}), ...(child.info.error ? { error: child.info.error } : {}) });
      await this.parent.hooks?.dispatch("SubagentStop", { agentId: id, parentSessionId: child.info.parentSessionId, status: child.info.status, result: child.info.result }, this.parent).catch(() => undefined);
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    const write = async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const temp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify({ schemaVersion: 1, agents: this.list() }, null, 2), { encoding: "utf8", flag: "wx" });
      await fs.rename(temp, this.statePath);
    };
    this.persistQueue = this.persistQueue.then(write, write);
    return this.persistQueue;
  }

  private cancelBoundTask(info: ChildAgentInfo, reason = "子 Agent 已取消"): void {
    if (!info.taskId) return;
    const task = this.parent.taskGraph?.get(info.taskId);
    if (task && task.status !== "cancelled" && task.status !== "completed" && task.status !== "done") {
      this.parent.taskGraph?.cancel(info.taskId, reason);
    }
  }
}

function selectForkMessages(messages: readonly Message[], mode: "none" | "all" | number): Message[] {
  if (mode === "none") return [];
  if (mode === "all") return messages.map((message) => structuredClone(message));
  if (!Number.isInteger(mode) || mode <= 0) throw new Error("forkMode 必须是 none、all 或正整数 turns");
  let users = 0; const selected: Message[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") users += 1;
    selected.unshift(structuredClone(message));
    if (users >= mode) break;
  }
  return selected;
}
