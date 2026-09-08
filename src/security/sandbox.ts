import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type SandboxFilesystem = "none" | "workspace" | "unrestricted";
export type SandboxEnvironment = "filtered" | "unrestricted";
export type SandboxEnforcement = "none" | "best_effort" | "process" | "os" | "container";
export type SandboxNetworkMode = "deny" | "allow" | "allowlist";

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
  /** Actual enforcement level, not the requested policy. */
  enforcement: SandboxEnforcement;
  filesystemEnforced: boolean;
  networkEnforced: boolean;
  processTreeTracked: boolean;
  shellDialect: "bash" | "cmd" | "powershell";
  platform: string;
}

export interface SandboxProfile {
  workspaceRoot: string;
  readRoots: string[];
  writeRoots: string[];
  protectedPaths: string[];
  network: { mode: SandboxNetworkMode; hosts?: string[] };
  environment: { mode: "minimal" | "filtered" | "inherited"; allow: string[] };
  process: { allowChildren: boolean; maxProcesses?: number };
  limits: { wallTimeMs: number; outputBytes: number };
  session: "one_shot" | "persistent";
  strictness: "required" | "preferred" | "best_effort";
}

export interface SandboxRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  profile?: SandboxProfile;
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
  outputTruncated?: boolean;
  executionId?: string;
}

export interface SandboxProvider {
  capabilities(): SandboxCapabilities;
  execute(request: SandboxRequest): Promise<SandboxResult>;
  readOutput?(executionId: string, tailLines?: number): string;
}

export interface SandboxAdmission {
  profile: SandboxProfile;
  capabilities: SandboxCapabilities;
}

export class SandboxManager {
  constructor(private readonly provider: SandboxProvider) {}

  admit(profile: SandboxProfile, requirements?: SandboxRequest["requirements"]): SandboxAdmission {
    const capabilities = this.provider.capabilities();
    const missing = missingSandboxCapabilities(capabilities, requirements);
    if (profile.strictness === "required") {
      if (!capabilities.osEnforced) missing.push("OS-enforced sandbox");
      if (!capabilities.filesystemEnforced) missing.push("enforced filesystem boundary");
      if (profile.network.mode === "deny" && !capabilities.networkEnforced) missing.push("enforced network denial");
      if (!capabilities.processTreeTracked) missing.push("tracked process tree");
    }
    if (missing.length > 0) throw new SandboxCapabilityError([...new Set(missing)]);
    return { profile, capabilities };
  }
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
  private readonly outputs = new Map<string, string>();

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
      enforcement: "best_effort",
      filesystemEnforced: false,
      networkEnforced: false,
      processTreeTracked: false,
      shellDialect: process.platform === "win32" ? "cmd" : "bash",
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
        const executionId = randomUUID();
        this.outputs.set(executionId, [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : ""].filter(Boolean).join("\n"));
        resolve({ ...result, executionId });
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

  readOutput(executionId: string, tailLines?: number): string {
    const output = this.outputs.get(executionId) ?? "";
    return tailLines && tailLines > 0 ? output.split("\n").slice(-tailLines).join("\n") : output;
  }

}

export interface WindowsDockerSandboxOptions {
  image?: string;
  dockerCommand?: string;
  outputBytes?: number;
}

/**
 * Strict Windows-host provider backed by Docker Desktop's isolated worker.
 * The Docker CLI arguments are fixed by this adapter; model input is passed
 * only as one argument to the worker shell and never becomes Docker argv.
 */
export class WindowsDockerSandboxProvider implements SandboxProvider {
  private readonly root: string;
  private readonly image: string;
  private readonly dockerCommand: string;
  private readonly outputBytes: number;
  private readonly outputs = new Map<string, string>();

  constructor(root: string, options: WindowsDockerSandboxOptions = {}) {
    this.root = path.resolve(root);
    this.image = options.image ?? process.env.SWE_SANDBOX_IMAGE ?? "node:22-bookworm-slim";
    this.dockerCommand = options.dockerCommand ?? process.env.SWE_DOCKER_COMMAND ?? "docker";
    this.outputBytes = options.outputBytes ?? 1_048_576;
  }

  capabilities(): SandboxCapabilities {
    if (process.platform !== "win32") return unavailableCapabilities();
    return {
      filesystem: "workspace",
      network: "deny",
      subprocess: true,
      workingDirectory: true,
      environment: "filtered",
      timeout: true,
      cancellation: true,
      osEnforced: true,
      enforcement: "container",
      filesystemEnforced: true,
      networkEnforced: true,
      processTreeTracked: true,
      shellDialect: "bash",
      platform: "windows-docker",
    };
  }

  async execute(request: SandboxRequest): Promise<SandboxResult> {
    if (process.platform !== "win32") throw new SandboxCapabilityError(["Windows strict sandbox"]);
    const missing = missingSandboxCapabilities(this.capabilities(), request.requirements);
    if (missing.length > 0) throw new SandboxCapabilityError(missing);
    const cwd = path.resolve(request.cwd);
    if (!isWithin(this.root, cwd)) throw new SandboxCapabilityError(["workspace cwd"]);
    if (request.signal?.aborted) throw request.signal.reason ?? new Error("沙箱执行已取消");
    this.assertStrictProfile(request.profile);

    const containerName = `minimal-swe-agent-${randomUUID().replace(/-/g, "")}`;
    const gitMount = await readOnlyMount(this.root, ".git");
    const emptySecret = await createEmptySecretFileIfPresent(this.root);
    const relativeCwd = path.relative(this.root, cwd).replace(/\\/g, "/");
    const containerCwd = relativeCwd ? `/workspace/${relativeCwd}` : "/workspace";
    const args = [
      "run", "--rm", "--pull=never", "--init", "--name", containerName,
      "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--pids-limit", "256",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
      "--volume", `${this.root}:/workspace`,
      ...(gitMount ? ["--volume", gitMount] : []),
      ...(emptySecret ? ["--volume", `${emptySecret.file}:/workspace/.env:ro`] : []),
      "--tmpfs", "/workspace/.swe-agent:rw,nosuid,nodev,noexec,size=16m",
      "--tmpfs", "/workspace/.claude:rw,nosuid,nodev,noexec,size=16m",
      "--tmpfs", "/workspace/.codex:rw,nosuid,nodev,noexec,size=16m",
      "--workdir", containerCwd,
      "--user", "node",
      ...dockerEnvironment(request.env),
      this.image, "/bin/sh", "-lc", request.command,
    ];

    return new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(this.dockerCommand, args, { cwd: this.root, env: filteredEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let outputTruncated = false;
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      const limit = request.profile?.limits.outputBytes ?? this.outputBytes;
      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString();
        const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
        const remaining = Math.max(0, limit - used);
        if (Buffer.byteLength(text) > remaining) outputTruncated = true;
        const clipped = Buffer.byteLength(text) <= remaining ? text : new TextDecoder().decode(Buffer.from(text, "utf8").subarray(0, remaining));
        if (target === "stdout") stdout += clipped;
        else stderr += clipped;
      };
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        void removeContainer(this.dockerCommand, containerName);
        if (emptySecret) void fs.rm(emptySecret.directory, { recursive: true, force: true });
      };
      const finish = (result: SandboxResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        const executionId = randomUUID();
        this.outputs.set(executionId, [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : ""].filter(Boolean).join("\n"));
        resolve({ ...result, executionId });
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cancelled = true;
        void removeContainer(this.dockerCommand, containerName);
        terminate(child);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        void removeContainer(this.dockerCommand, containerName);
        terminate(child);
      }, request.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", fail);
      child.once("close", (exitCode) => finish({ stdout, stderr, exitCode, timedOut, cancelled, outputTruncated }));
      request.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  readOutput(executionId: string, tailLines?: number): string {
    const output = this.outputs.get(executionId) ?? "";
    return tailLines && tailLines > 0 ? output.split("\n").slice(-tailLines).join("\n") : output;
  }

  private assertStrictProfile(profile?: SandboxProfile): void {
    if (!profile) return;
    if (path.resolve(profile.workspaceRoot) !== this.root) throw new SandboxCapabilityError(["sandbox workspace root"]);
    if (profile.network.mode !== "deny") throw new SandboxCapabilityError(["network deny profile"]);
    if (profile.environment.mode === "inherited") throw new SandboxCapabilityError(["filtered environment"]);
    if (profile.session !== "one_shot") throw new SandboxCapabilityError(["one-shot session"]);
    if (profile.readRoots.some((root) => !isWithin(this.root, path.resolve(root)))) throw new SandboxCapabilityError(["workspace read roots"]);
    if (profile.writeRoots.some((root) => !isWithin(this.root, path.resolve(root)))) throw new SandboxCapabilityError(["workspace write roots"]);
  }
}

export class UnavailableSandboxProvider implements SandboxProvider {
  capabilities(): SandboxCapabilities {
    return unavailableCapabilities();
  }

  async execute(_request: SandboxRequest): Promise<SandboxResult> {
    throw new SandboxCapabilityError(["sandbox provider"]);
  }
  readOutput(): string { return ""; }
}

export function createSandboxProfile(root: string, timeoutMs: number, strictness: SandboxProfile["strictness"] = "best_effort"): SandboxProfile {
  const workspaceRoot = path.resolve(root);
  return {
    workspaceRoot,
    readRoots: [workspaceRoot],
    writeRoots: [workspaceRoot],
    protectedPaths: [".git", ".swe-agent", ".claude", ".codex", ".env"],
    network: { mode: "deny" },
    environment: { mode: "filtered", allow: ["PATH", "TEMP", "TMP", "LANG", "LC_ALL"] },
    process: { allowChildren: true, maxProcesses: 256 },
    limits: { wallTimeMs: timeoutMs, outputBytes: 1_048_576 },
    session: "one_shot",
    strictness,
  };
}

export function sandboxProfileFingerprint(profile: SandboxProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

function filteredEnvironment(patch?: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key) && value !== undefined) env[key] = value;
  for (const [key, value] of Object.entries(patch ?? {})) if (allowed.has(key)) env[key] = value;
  return env;
}

function dockerEnvironment(patch?: Record<string, string>): string[] {
  const allowed = new Set(["CI", "LANG", "LC_ALL", "TZ", "NODE_ENV"]);
  const env = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => allowed.has(key)));
  return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

async function createEmptySecretFileIfPresent(root: string): Promise<{ directory: string; file: string } | null> {
  try {
    const stat = await fs.stat(path.join(root, ".env"));
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minimal-swe-agent-secret-"));
  const file = path.join(directory, ".env");
  await fs.writeFile(file, "", { encoding: "utf8", flag: "wx" });
  return { directory, file };
}

async function readOnlyMount(root: string, relativePath: string): Promise<string | null> {
  try {
    await fs.stat(path.join(root, relativePath));
    return `${path.join(root, relativePath)}:/workspace/${relativePath.replace(/\\/g, "/")}:ro`;
  } catch {
    return null;
  }
}

async function removeContainer(dockerCommand: string, name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(dockerCommand, ["rm", "-f", name], { stdio: "ignore", windowsHide: true });
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

function unavailableCapabilities(): SandboxCapabilities {
  return {
    filesystem: "none", network: "deny", subprocess: false, workingDirectory: false,
    environment: "filtered", timeout: false, cancellation: false, osEnforced: false,
    enforcement: "none", filesystemEnforced: false, networkEnforced: false,
    processTreeTracked: false, shellDialect: process.platform === "win32" ? "cmd" : "bash", platform: process.platform,
  };
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
