import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

export interface ManagedWorktree { root: string; parentRoot: string; createdAt: number; fingerprint: string }

/** Creates detached Git worktrees and records ownership so child agents cannot escape their root. */
export class WorktreeManager {
  constructor(private readonly root: string) {}

  async create(parentRoot: string): Promise<ManagedWorktree> {
    const gitRoot = (await execFileAsync("git", ["-C", parentRoot, "rev-parse", "--show-toplevel"])).stdout.trim();
    if (!gitRoot) throw new Error("父工作区不是 Git 仓库");
    await fs.mkdir(this.root, { recursive: true });
    const checkout = path.join(this.root, `agent-${randomUUID()}`);
    await execFileAsync("git", ["-C", gitRoot, "worktree", "add", "--detach", checkout, "HEAD"]);
    const metadata = { root: checkout, parentRoot: gitRoot, createdAt: Date.now(), fingerprint: randomUUID() };
    await fs.writeFile(path.join(checkout, ".swe-agent-worktree.json"), JSON.stringify(metadata), "utf8");
    return metadata;
  }

  async remove(worktree: ManagedWorktree): Promise<void> {
    const metadata = JSON.parse(await fs.readFile(path.join(worktree.root, ".swe-agent-worktree.json"), "utf8")) as ManagedWorktree;
    if (metadata.root !== worktree.root || metadata.parentRoot !== worktree.parentRoot || metadata.fingerprint !== worktree.fingerprint) throw new Error("worktree ownership metadata 不匹配");
    await execFileAsync("git", ["-C", worktree.parentRoot, "worktree", "remove", "--force", worktree.root]);
  }

  async changedPaths(worktree: ManagedWorktree): Promise<string[]> {
    const result = await execFileAsync("git", ["-C", worktree.root, "status", "--porcelain", "--untracked-files=all"]);
    return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim().replace(/\\/g, "/")).filter((item) => item && item !== ".swe-agent-worktree.json").sort();
  }

  async conflicts(left: ManagedWorktree, right: ManagedWorktree): Promise<string[]> {
    const [a, b] = await Promise.all([this.changedPaths(left), this.changedPaths(right)]);
    return a.filter((item) => b.includes(item));
  }
}
