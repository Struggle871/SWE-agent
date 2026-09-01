import { spawn } from "node:child_process";
import path from "node:path";

export type SandboxFilesystem = "none" | "workspace" | "unrestricted";
export type SandboxEnvironment = "filtered" | "unrestricted";

export interface SandboxCapabilities {
  filesystem: SandboxFilesystem;
  network: "deny" | "allow";
  subprocess: boolean;
  workingDirectory: boolean;
  environment: SandboxEnvironment;
  timeout: boolean;
  cancellation: boolean;
  /** true only when the provider uses an OS-level boundary. */
  osEnforced: boolean;
  platform: string;
}

export interface SandboxRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  requirements?: {
    filesystem?: SandboxFilesystem;
    network?: boolean;
    subprocess?: boolean;
    workingDirectory?: boolean;
    environment?: SandboxEnvironment;
    timeout?: boolean;
    cancellation?: boolean;
  };
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
}

export interface SandboxProvider {
  capabilities(): SandboxCapabilities;
  execute(request: SandboxRequest): Promise<SandboxResult>;
}

export class SandboxCapabilityError extends Error {
  constructor(public readonly missing: string[]) {
    super(`沙箱缺少必需能力: ${missing.join("、")}`);
    this.name = "SandboxCapabilityError";
  }
}

export function missingSandboxCapabilities(
  capabilities: SandboxCapabilities,
  requirements: SandboxRequest["requirements"],
): string[] {
  if (!requirements) return [];
  const missing: string[] = [];
  if (requirements.filesystem === "workspace" && capabilities.filesystem === "none") missing.push("workspace filesystem");
  if (requirements.filesystem === "unrestricted" && capabilities.filesystem !== "unrestricted") missing.push("unrestricted filesystem");
  if (requirements.network && capabilities.network !== "allow") missing.push("network");
  if (requirements.subprocess && !capabilities.subprocess) missing.push("subprocess");
  if (requirements.workingDirectory && !capabilities.workingDirectory) missing.push("working directory");
  if (requirements.environment === "filtered" && capabilities.environment !== "filtered") missing.push("filtered environment");
  if (requirements.environment === "unrestricted" && capabilities.environment !== "unrestricted") missing.push("unrestricted environment");
  if (requirements.timeout && !capabilities.timeout) missing.push("timeout");
  if (requirements.cancellation && !capabilities.cancellation) missing.push("cancellation");
  return missing;
}

/**
 * Portable adapter used by the local CLI. It constrains cwd and environment
 * before spawning a child, but deliberately does not claim OS-level isolation.
 * Platform-specific providers can replace it without changing ToolRuntime.
 */
export class LocalSandboxProvider implements SandboxProvider {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  capabilities(): SandboxCapabilities {
    return {
      filesystem: "workspace",
      network: "deny",
      subprocess: true,
      workingDirectory: true,
      environment: "filtered",
      timeout: true,
      cancellation: true,
      osEnforced: false,
      platform: process.platform,
    };
  }

  async execute(request: SandboxRequest): Promise<SandboxResult> {
    const missing = missingSandboxCapabilities(this.capabilities(), request.requirements);
    if (missing.length > 0) throw new SandboxCapabilityError(missing);
    const cwd = path.resolve(request.cwd);
    if (!isWithin(this.root, cwd)) throw new SandboxCapabilityError(["workspace cwd"]);
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("沙箱执行已取消");

    const shell = process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/bash";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", request.command] : ["--noprofile", "--norc", "-c", request.command];
    const env = filteredEnvironment(request.env);
    return new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(shell, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      const finish = (result: SandboxResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cancelled = true;
        terminate(child);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, request.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", fail);
      child.once("close", (exitCode) => finish({ stdout, stderr, exitCode, timedOut, cancelled }));
      request.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export class UnavailableSandboxProvider implements SandboxProvider {
  capabilities(): SandboxCapabilities {
    return {
      filesystem: "none", network: "deny", subprocess: false, workingDirectory: false,
      environment: "filtered", timeout: false, cancellation: false, osEnforced: false, platform: process.platform,
    };
  }

  async execute(_request: SandboxRequest): Promise<SandboxResult> {
    throw new SandboxCapabilityError(["sandbox provider"]);
  }
}

function filteredEnvironment(patch?: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key) && value !== undefined) env[key] = value;
  for (const [key, value] of Object.entries(patch ?? {})) env[key] = value;
  return env;
}

function isWithin(root: string, candidate: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = normalize(root);
  const c = normalize(candidate);
  return c === r || c.startsWith(`${r}/`);
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.once("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
}
