# Sandbox Design v1

> 状态：Windows 单平台安全闭环已开始实现；本文中的跨平台 provider 和 persistent session 仍属于后续设计
>
> 日期：2026-09-04
>
> 适用范围：`run_command`、持久终端、子进程、网络和资源限制

## 1. 结论

当前项目已经有 `SandboxProvider` 接口和 `LocalSandboxProvider`，但它们还不是完整的沙箱设计：

- `LocalSandboxProvider` 能限制启动 cwd、过滤环境变量、超时和取消。
- 它不能从操作系统层面阻止子进程访问工作区外文件或访问网络。
- `osEnforced: false` 已经表达了这一点，但当前 `filesystem: "workspace"` 和 `network: "deny"` 容易让调用方误以为这些限制已经被强制执行。
- `ShellSession` 和 `SandboxProvider` 目前有两条执行路径，目标应收敛为由 Provider 自己拥有命令会话。

本设计的核心原则是：

> 沙箱能力必须描述“能够强制保证什么”，不能描述“调用方希望它做到什么”。

没有真实 OS 或容器边界时，高风险和动态命令必须明确降级为 `ask` 或 `deny`，不能静默执行。

## 2. 目标与非目标

### 2.1 目标

1. 对每个命令给出可解释的安全保证等级。
2. 将静态命令分析、用户审批和运行时隔离串成一个固定生命周期。
3. 支持一次性命令和持久 Shell，但两者语义必须明确。
4. 近期只在 Windows 上完成真实隔离；macOS/Linux provider 延期，不创建未实现的空壳后端。
5. 默认不把 API key、Token、Password、SSH agent 或代理凭据传给子进程。
6. 记录 sandbox plan、实际 enforcement、退出原因和资源结果，支持后续恢复和评测。

### 2.2 非目标

- 不在 TypeScript 中重新实现操作系统沙箱。
- 不把字符串黑名单当成运行时安全边界。
- 不承诺普通子进程能够防御内核漏洞、宿主机管理员或用户主动绕过系统权限。
- 不让用户审批扩大 OS/container 能力边界。

## 3. 分层架构

```text
ToolRouter
  -> ToolPreflight
  -> CommandAnalyzer
  -> PermissionPolicy / ApprovalBroker
  -> SandboxPlanner
  -> SandboxManager.admit
  -> SandboxProvider.start / execute
  -> ProcessTree + ResourceMonitor
  -> SandboxProvider.close
  -> AuditTrail
```

职责边界：

- `CommandAnalyzer`：回答命令语义和风险，不执行命令。
- `PermissionPolicy`：回答用户是否需要审批，不提供隔离能力。
- `SandboxPlanner`：把风险和配置转换成具体的 sandbox profile。
- `SandboxManager`：检查 Provider 能否满足 profile，并拒绝能力不足的执行。
- `SandboxProvider`：负责启动、监控、取消和关闭受限运行环境。
- `ToolRuntime`：只消费已经通过 admission 的运行句柄，不再自行决定是否裸执行。
- `AuditTrail`：记录计划能力与实际能力，不能只记录 `success`。

## 4. 安全保证等级

当前 `SandboxCapabilities` 需要从“有几个布尔字段”升级为“保证等级 + 可强制约束项”。建议类型如下：

```ts
type SandboxEnforcement =
  | "none"          // 没有隔离，只是普通子进程
  | "best_effort"   // cwd/env/进程树等应用层限制
  | "process"       // OS 级进程树和资源控制，但不保证文件/网络边界
  | "os"            // OS 级文件、网络或系统调用边界
  | "container";    // 容器级文件、网络和进程边界

type NetworkMode = "deny" | "allow" | "allowlist";

interface SandboxGuarantees {
  enforcement: SandboxEnforcement;
  filesystem: {
    read: "none" | "workspace" | "declared_roots" | "host";
    write: "none" | "workspace" | "declared_roots" | "host";
    enforced: boolean;
  };
  network: {
    mode: NetworkMode;
    enforced: boolean;
  };
  processTree: {
    tracked: boolean;
    killable: boolean;
    enforced: boolean;
  };
  environment: {
    mode: "minimal" | "filtered" | "inherited";
    enforced: boolean;
  };
  persistentSession: boolean;
  timeout: boolean;
  cancellation: boolean;
}
```

关键不变量：

- `network.mode === "deny"` 且 `enforced === true`，才可以宣称网络被禁止。
- `filesystem.write === "workspace"` 且 `enforced === true`，才可以宣称只能写工作区。
- `enforcement === "process"` 只能说明进程生命周期或资源受到控制，不能说明文件和网络安全。
- `LocalSandboxProvider` 不应返回 `filesystem.enforced: true` 或 `network.enforced: true`。
- 用户审批只能改变 `PermissionPolicy` 的 decision，不能把 `enforced` 从 `false` 变成 `true`。

## 5. SandboxProfile

`SandboxRequest` 不应只接收一段 command 字符串，还应接收经过规范化的 profile：

```ts
interface SandboxProfile {
  profileId: string;
  workspaceRoot: string;
  readRoots: string[];
  writeRoots: string[];
  tempRoots: string[];
  protectedPaths: string[];
  network: {
    mode: "deny" | "allow" | "allowlist";
    hosts?: string[];
    proxy?: string;
  };
  environment: {
    allow: string[];
    values: Record<string, string>;
  };
  process: {
    allowChildren: boolean;
    maxProcesses?: number;
  };
  limits: {
    wallTimeMs: number;
    cpuTimeMs?: number;
    memoryBytes?: number;
    outputBytes: number;
  };
  session: "one_shot" | "persistent";
  strictness: "required" | "preferred" | "best_effort";
}
```

默认 profile：

```text
readRoots       = workspace root + declared read roots
writeRoots      = workspace writable roots
protectedPaths  = .git, .swe-agent, .claude, .codex, .env, credentials
network         = deny
environment     = minimal/filtered
children        = allowed but tracked
session         = one_shot until persistent sandbox is implemented
strictness      = required for dynamic/network/destructive commands
```

`protectedPaths` 仍然要经过 `WorkspacePolicy` 和命令分析；它不是 OS 沙箱的替代品。能强制时由 Provider 再次强制，不能强制时必须在 admission 中反映限制不足。

## 6. 固定执行生命周期

所有 `run_command` 必须遵循以下顺序：

```text
1. validate + normalize input
2. resolve canonical cwd and path references
3. parse shell and build AST
4. calculate command risk and sandbox requirements
5. build preview + SandboxProfile
6. PermissionPolicy: allow / ask / deny
7. ApprovalBroker, if needed
8. repeat steps 2-5 and compare fingerprints
9. SandboxManager.admit(profile, provider.guarantees())
10. start sandbox and process tree
11. execute command
12. enforce timeout/output/resource limits
13. cancel and terminate the complete process tree when requested
14. close session or keep it alive according to profile.session
15. audit planned vs actual guarantees and final status
```

`ToolRouter` 不再只通过 `assertSandbox()` 检查几个字段，而应调用：

```ts
const admission = await sandboxManager.admit({
  profile,
  assessment,
  signal,
});
const result = await admission.session.execute(command, signal);
```

## 7. Provider 设计

### 7.1 LocalBestEffortProvider

这是当前 `LocalSandboxProvider` 的正确定位：

- 限制启动 cwd。
- 过滤环境变量。
- 使用 `windowsHide`、超时和取消。
- Windows 使用 `taskkill /t /f` 尝试终止进程树。
- 不宣称文件系统隔离。
- 不宣称网络隔离。
- 动态展开、脚本解释器、网络命令和破坏性命令默认要求更强 Provider。

它适合：

- 低风险、静态、只读命令。
- 测试环境中的协议验证。
- 没有 Docker/OS sandbox 时的明确 best-effort 模式。

它不适合：

- 运行不可信仓库中的安装脚本。
- 允许网络访问的依赖安装。
- 用户要求严格阻止工作区外读取或写入的场景。

### 7.2 WindowsProvider

Windows 上建议分两级：

**进程控制级**：Job Object。

- 绑定 Worker 和所有后代进程。
- 限制 CPU、内存、进程数量和生命周期。
- 支持关闭整个进程树。
- 明确标记为 `enforcement: "process"`。
- 不能单独宣称文件系统或网络隔离。

Windows Job Object 的职责是进程和资源控制，不应被当作完整文件沙箱。

**当前实现的严格隔离级**：Docker Desktop Worker。

- Worker 在独立容器或 WSL 环境中运行。
- workspace 使用显式 bind mount。
- 结果目录单独挂载。
- 默认 `network=none`。
- 只传入非敏感环境变量。
- 容器启动参数固定模板化，禁止模型直接拼接 Docker argv。
- 支持模型代理在宿主机运行，Worker 不接触 API key。

当前代码实现为 `WindowsDockerSandboxProvider`：

- Windows CLI 默认选择该 provider。
- Docker 镜像使用 `--pull=never`，避免执行阶段隐式拉取镜像。
- 启用 `--network none`、`--read-only`、`--cap-drop ALL`、`no-new-privileges` 和 pids limit。
- 只把工作区挂载到 `/workspace`；`.git` 以只读 mount 暴露，`.swe-agent`、`.claude`、`.codex` 以临时文件系统遮蔽，存在的 `.env` 以空文件遮蔽。
- 超时、取消或进程结束后执行容器清理。
- Docker 不可用时返回执行错误，不回退到普通 Shell。

这属于 Windows 主机上的容器级 strict provider，不等同于 Codex 的 native Windows ACL/restricted-token/WFP 全套后端；native Windows backend 延后实现。

Docker 的只读 root filesystem、显式 mount 和 `network=none` 适合表达严格 profile；容器的 mount 仍需结合路径 canonicalization，不能跳过应用层策略。

### 7.3 macOSProvider（延期）

采用 Seatbelt profile adapter：

- workspace 可按 profile 写入。
- home、`.ssh`、`.aws`、`.env`、Agent 配置和其他敏感路径默认拒绝。
- 网络默认关闭。
- 环境使用白名单。
- profile 不存在或 `sandbox-exec` 不可用时 fail closed。

Provider 必须把 profile hash 和实际启动参数摘要写入审计，不能把完整敏感路径或环境变量原样写入日志。

### 7.4 LinuxProvider（延期）

建议组合使用：

- bubblewrap：用户命名空间、挂载视图和最小根文件系统。
- Landlock：对文件系统访问追加不可放宽的路径限制。
- seccomp：减少不需要的系统调用面，但不把 seccomp 单独当作完整沙箱。
- network namespace：默认无网络；allowlist 需要代理或其他明确的 egress 控制。

Linux Provider 必须检查内核和工具能力，能力不满足时返回 admission failure，不静默退回裸 Shell。

### 7.5 通用 DockerProvider（后续抽象）

DockerProvider 可以作为所有平台的严格后端：

- `--network none` 作为默认网络模式。
- `--read-only` root filesystem。
- workspace 和结果目录使用显式 mount。
- 丢弃不需要的 capabilities。
- `no-new-privileges`。
- 禁止挂载 Docker socket、宿主机 home、SSH agent 和完整环境变量。
- 运行结束后强制删除容器。

它适合 SWE-bench、CI、批量评测和不可信仓库。交互式本地使用时需要缓存镜像并管理启动延迟。

## 8. 一次性命令与持久终端

当前两条执行路径必须合并。目标接口：

```ts
interface SandboxSession {
  readonly id: string;
  readonly profile: SandboxProfile;
  execute(command: ShellCommand, signal: AbortSignal): Promise<SandboxResult>;
  readPending(options?: { tailLines?: number }): Promise<string>;
  interrupt(reason: string): Promise<void>;
  close(reason?: string): Promise<void>;
}

interface SandboxProvider {
  guarantees(): SandboxGuarantees;
  createSession(profile: SandboxProfile, signal: AbortSignal): Promise<SandboxSession>;
}
```

约束：

- `run_command` 和 `read_terminal_output` 必须使用同一个 `SandboxSession`。
- session 内部拥有 Shell、cwd、环境变量、后台进程和输出缓冲区。
- 每次命令执行前仍需做新的 AST/risk/preflight；持久 session 不能绕过安全链。
- Shell 的 cwd 变化必须由 session 记录并重新 canonicalize。
- 如果 Provider 无法可靠观测 cwd、后台进程和取消状态，则只能提供 `one_shot`，不能伪装成 persistent。
- 工具超时或取消时必须终止整个 session 的进程树，并将结果标记为 `cancelled` 或 `timed_out`。

实现顺序建议：先把 CLI 语义明确为 `one_shot` 且去掉错误的持久终端声明，再实现 Provider-owned persistent session。不要保留当前“双路径同时存在”的状态。

## 9. SandboxManager 与准入规则

建议新增 `SandboxManager`：

```ts
interface SandboxAdmission {
  provider: string;
  profile: SandboxProfile;
  guarantees: SandboxGuarantees;
  profileFingerprint: string;
  session: SandboxSession;
}

interface SandboxManager {
  admit(input: {
    profile: SandboxProfile;
    assessment: CommandAssessment;
    signal: AbortSignal;
  }): Promise<SandboxAdmission>;
}
```

准入规则：

- `deny` 命令永远不进入 Provider。
- 动态命令要求 `enforcement` 至少为 `os` 或 `container`。
- 要求网络关闭时，Provider 必须 `network.mode === "deny"` 且 `enforced === true`。
- 要求工作区写入时，Provider 必须有强制写入边界，或者命令只能进入明确的 best-effort 审批策略。
- 子进程执行必须有 process-tree tracking 和 cancellation；否则不满足要求。
- `strictness === "required"` 时能力不足直接失败。
- `strictness === "preferred"` 时只能在用户明确知道降级的情况下进入审批，并记录降级原因。
- `strictness === "best_effort"` 只允许低风险场景。

## 10. 审计和错误模型

新增 sandbox 专用审计字段：

```ts
interface SandboxAudit {
  provider: string;
  profileFingerprint: string;
  requestedEnforcement: SandboxEnforcement;
  actualEnforcement: SandboxEnforcement;
  requestedNetwork: NetworkMode;
  actualNetwork: NetworkMode;
  requestedReadRoots: string[];
  requestedWriteRoots: string[];
  degraded: boolean;
  degradationReasons: string[];
  pid?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
}
```

建议错误类型：

```ts
type SandboxError =
  | { kind: "sandbox_unavailable"; provider: string; required: string[] }
  | { kind: "sandbox_capability"; missing: string[] }
  | { kind: "sandbox_violation"; resource: string; detail: string }
  | { kind: "sandbox_timeout"; timeoutMs: number }
  | { kind: "sandbox_cancelled"; reason: string }
  | { kind: "sandbox_unknown_outcome"; pid?: number; detail: string };
```

`unknown_outcome` 很重要：如果进程在写入过程中被杀死，系统不能简单返回“失败后可以重试”。后续 Transcript/Resume 必须要求用户检查文件状态。

## 11. 测试设计

### 11.1 Provider contract tests

所有 Provider 共用以下契约测试：

- capability 声明与实际行为一致。
- 缺少 required capability 时不会启动命令。
- timeout 会结束完整进程树。
- cancellation 会结束完整进程树。
- 输出达到上限时停止或截断，并记录状态。
- API key、Token、Password 不进入子进程环境。
- profile fingerprint 变化时旧 admission 不能复用。

### 11.2 文件和网络边界测试

- 读取 workspace 外文件被拒绝。
- 写入 workspace 外文件被拒绝。
- workspace 内 symlink/junction 不能逃逸。
- protected paths 不能通过命令写入。
- `network=deny` 时 curl、Node、Python 和子 Shell 都不能建立外部连接。
- 子进程再启动子进程时仍继承限制。

### 11.3 Shell session 测试

- `cd` 后下一条命令看到新的 canonical cwd。
- 环境变量只在同一 session 内保留。
- 后台进程输出可以通过 `read_terminal_output` 读取。
- session timeout 后后台子进程全部结束。
- session close 后没有残留进程。
- Provider 不能观测持久状态时，明确返回 one-shot，不声称 persistent。

### 11.4 平台测试

- Windows Docker/WSL strict provider 使用真实边界测试。
- Windows Job Object 只测试进程树和资源限制，不测试它不存在的文件/网络隔离。
- macOS Seatbelt 测试在未包裹的普通 Terminal 中运行。
- Linux Landlock/bubblewrap 测试检查内核、命名空间和工具缺失时的 fail-closed 行为。
- CI 没有对应平台时只运行 provider contract tests，不把 mock 当作 OS 隔离证明。

## 12. 实施里程碑

### S0：修正语义（已实现）

- `SandboxCapabilities` 已增加 enforcement、filesystem/network enforced 和 process-tree tracking 字段。
- `LocalSandboxProvider` 明确标记为 best-effort。
- README 和工具描述已将当前命令模式标为 provider-controlled one-shot。
- 已增加 strict capability admission 和 secret environment 测试。

### S1：SandboxManager（已实现基础准入）

- 已从 `ToolRouter.assertSandbox()` 接入 `SandboxManager`。
- `run_command` 已携带规范化 `SandboxProfile`。
- strict provider 会检查 OS、文件系统、网络和进程树保证等级。
- profile 进入 runtime；完整 profile fingerprint/admission handle 仍需后续持久化设计。

### S2：Windows strict provider（已实现 Docker adapter，真实环境测试待补）

- 已实现 `WindowsDockerSandboxProvider`，支持 `network=none`、显式 workspace mount、只读 rootfs、最小环境和容器清理。
- Job Object 尚未实现；未来只能作为 process/resource provider，不能单独满足 filesystem/network strict profile。
- 真实 Docker Desktop 边界测试需要在安装 Docker 的 Windows 环境中执行，当前单元测试不把 mock 当作隔离证明。

### S3：Provider-owned persistent session（延期）

- 将 ShellSession 移入 Provider。
- `run_command` 与 `read_terminal_output` 共享 session。
- 加入 cwd/env/background process 生命周期测试。

### S4：跨平台 Provider（延期）

- macOS Seatbelt。
- Linux bubblewrap + Landlock + seccomp 组合。
- Docker 作为 CI/SWE-bench 通用后端。

### S5：恢复和评测接入

- 将 sandbox start/exit/violation 写入 Transcript。
- 取消写操作时记录 unknown outcome。
- 在真实任务评测中统计 sandbox denial、降级次数、超时和残留进程。

## 13. 关键决策

1. `SandboxProvider` 是执行后端契约，不是完整设计本身。
2. capability 必须携带 enforcement，区分“能做”和“能保证”。
3. Windows Job Object 只作为进程/资源控制，不伪装成文件沙箱。
4. 近期目标是 Windows 单平台安全闭环；Windows strict 优先使用 Docker Desktop Worker，本地 best-effort 只能明确选择。
5. 网络 allowlist 不由命令分析器保证，应由容器网络或 egress proxy 保证。
6. 持久终端必须由 Provider 拥有，不能同时存在未关联的 ShellSession 和 SandboxProvider。
7. 所有高风险、动态和不确定命令在缺少强隔离时 fail closed。

## 14. 参考资料

- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Docker container run reference](https://docs.docker.com/reference/cli/docker/container/run/)
- [Docker none network driver](https://docs.docker.com/engine/network/drivers/none/)
- [Linux Landlock userspace API](https://docs.kernel.org/userspace-api/landlock.html)
- [bubblewrap](https://github.com/containers/bubblewrap)
