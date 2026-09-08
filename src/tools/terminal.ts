import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { JsonSchema, ShellResult, ToolResult } from "../types.js";
import { createSandboxProfile } from "../security/sandbox.js";
import type { Tool, RuntimeExecuteOptions } from "./types.js";

interface ShellSpec {
  command: string;
  args: string[];
  newline: string;
  prompt: string | null;
  envPatch: Record<string, string>;
  makeEcho(marker: string): string;
}

function resolveShell(): ShellSpec {
  if (process.platform === "win32") {
    return {
      command: process.env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/q"],
      newline: "\r\n",
      prompt: ">",
      envPatch: { PROMPT: "$G" },
      makeEcho: (m) => `echo ${m} %errorlevel%`,
    };
  }
  return {
    command: "/bin/bash",
    args: ["--noprofile", "--norc"],
    newline: "\n",
    prompt: null,
    envPatch: {},
    makeEcho: (m) => `echo ${m} $?`,
  };
}

export class ShellSession {
  private spec = resolveShell();
  private child: ChildProcessWithoutNullStreams;
  private bufferText = "";
  private consumedIndex = 0;
  private initialized = false;
  private pending: { marker: string; start: number; resolve: (r: ShellResult) => void } | null = null;
  private children = new Set<ChildProcessWithoutNullStreams>();

  constructor(private cwd: string) {
    this.child = this.spawn();
  }

  private spawn(): ChildProcessWithoutNullStreams {
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.spec.envPatch },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.children.add(child);

    child.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
    child.stderr.on("data", (d: Buffer) => this.onData(d.toString()));
    child.on("exit", () => {
      this.children.delete(child);
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.resolve({ stdout: stripPrompt(this.bufferText.slice(p.start), this.spec.prompt), stderr: "", exitCode: null });
      }
    });
    return child;
  }

  private onData(chunk: string): void {
    this.bufferText += chunk;
    if (!this.pending) return;

    const idx = this.bufferText.indexOf(this.pending.marker);
    if (idx === -1) return;

    const p = this.pending;
    this.pending = null;

    const lineEnd = this.bufferText.indexOf("\n", idx);
    const markerLine = lineEnd === -1 ? this.bufferText.slice(idx) : this.bufferText.slice(idx, lineEnd);
    const stdout = stripPrompt(this.bufferText.slice(p.start, idx), this.spec.prompt);
    const exitCode = parseExitCode(markerLine.slice(p.marker.length));
    this.consumedIndex = lineEnd === -1 ? this.bufferText.length : lineEnd + 1;

    p.resolve({ stdout, stderr: "", exitCode, timedOut: false });
  }

  async run(command: string, timeoutMs = 30000): Promise<ShellResult> {
    if (!this.child || this.child.killed || this.child.exitCode !== null) {
      this.bufferText = "";
      this.consumedIndex = 0;
      this.initialized = false;
      this.child = this.spawn();
    }

    await this.ensureReady();

    const marker = `__SWE_MARKER_${randomUUID().replace(/-/g, "")}__`;
    const start = this.bufferText.length;

    const resultPromise = new Promise<ShellResult>((resolve) => {
      this.pending = { marker, start, resolve };
    });

    this.child.stdin.write(command + this.spec.newline);
    this.child.stdin.write(this.spec.makeEcho(marker) + this.spec.newline);

    const timer = setTimeout(() => {
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.resolve({ stdout: stripPrompt(this.bufferText.slice(p.start), this.spec.prompt), stderr: "", exitCode: null, timedOut: true });
        this.restart();
      }
    }, timeoutMs);

    const result = await resultPromise;
    clearTimeout(timer);
    return result;
  }

  readPending(tailLines?: number): string {
    const pending = stripPrompt(this.bufferText.slice(this.consumedIndex), this.spec.prompt).trim();
    if (!pending) return "";
    if (!tailLines || tailLines <= 0) return pending;
    const lines = pending.split("\n");
    return lines.slice(-tailLines).join("\n").trim();
  }

  private async ensureReady(): Promise<void> {
    if (this.initialized) return;
    if (this.spec.prompt) {
      await this.waitForText(this.spec.prompt, 3000);
      this.bufferText = "";
      this.consumedIndex = 0;
    }
    this.initialized = true;
  }

  private waitForText(needle: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        if (this.bufferText.includes(needle)) {
          resolve();
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          resolve();
          return;
        }
        setTimeout(check, 15);
      };
      check();
    });
  }

  private restart(): void {
    void terminateProcessTree(this.child);
    this.bufferText = "";
    this.consumedIndex = 0;
    this.initialized = false;
    this.child = this.spawn();
  }

  async close(): Promise<void> {
    const children = [...this.children];
    for (const child of children) child.stdin.end();
    await Promise.all(children.map(terminateProcessTree));
  }
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      killer.once("exit", () => resolve());
      killer.once("error", () => { child.kill(); resolve(); });
    });
    await waitForExit(child);
    return;
  }
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function stripPrompt(s: string, prompt: string | null): string {
  if (!prompt) return s;
  return s.replace(/^\s*>\s*/, "").replace(/\s*>\s*$/, "");
}

function parseExitCode(s: string): number | null {
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function shellOutputToText(result: ShellResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout.trimEnd());
  if (result.stderr) parts.push("[stderr]\n" + result.stderr.trimEnd());
  if (result.timedOut) parts.push("（命令超时，已重启会话）");
  if (result.exitCode !== null) parts.push(`（exit code: ${result.exitCode}）`);
  return parts.join("\n") || "（无输出）";
}

const runCommandSchema: JsonSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "要执行的 shell 命令" },
    timeoutMs: { type: "number", description: "可选，命令超时时间（毫秒）" },
  },
  required: ["command"],
};

export const runCommandTool: Tool = {
  name: "run_command",
  description: "在当前沙箱 provider 控制的执行环境中运行一条命令，并返回输出与退出码",
  parameters: runCommandSchema,
  async execute(input, ctx, options?: RuntimeExecuteOptions): Promise<ToolResult> {
    const command = String(input.command ?? "");
    if (!command) return { toolName: "run_command", output: "缺少 command", isError: true };
    const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : ctx.config.toolTimeoutMs;
    const result = ctx.sandboxProvider
      ? await ctx.sandboxProvider.execute({
          command,
          cwd: ctx.workspaceRoot,
          timeoutMs,
          signal: options?.signal,
          profile: createSandboxProfile(
            ctx.workspaceRoot,
            timeoutMs,
            ctx.sandboxProvider?.capabilities().enforcement === "container" ? "required" : "best_effort",
          ),
          requirements: { filesystem: "workspace", network: false, subprocess: true, workingDirectory: true, environment: "filtered", timeout: true, cancellation: true },
        })
      : await ctx.shell.run(command, timeoutMs);
    ctx.workingMemory["lastCommand"] = command;
    if (result.executionId) ctx.workingMemory["lastExecutionId"] = result.executionId;
    ctx.workingMemory["lastExitCode"] = result.exitCode;
    return {
      toolName: "run_command",
      output: shellOutputToText(result),
      isError: result.exitCode !== 0 || result.timedOut,
    };
  },
};

export const readTerminalOutputTool: Tool = {
  name: "read_terminal_output",
  isReadOnly: true,
  description: "读取兼容终端会话缓冲区中尚未被消费的输出",
  parameters: {
    type: "object",
    properties: {
      tailLines: { type: "number", description: "可选，只返回最后 N 行" },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const tailLines = typeof input.tailLines === "number" ? input.tailLines : undefined;
    const executionId = typeof ctx.workingMemory["lastExecutionId"] === "string" ? ctx.workingMemory["lastExecutionId"] : undefined;
    const output = executionId && ctx.sandboxProvider?.readOutput ? ctx.sandboxProvider.readOutput(executionId, tailLines) : ctx.shell.readPending(tailLines);
    return { toolName: "read_terminal_output", output: output || "（缓冲区无待读输出）" };
  },
};
