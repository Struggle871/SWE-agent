# M7 设计：配置、AGENTS 与 Skills

> 状态（2026-09-08）：已接入基础 contextual-fragment runtime（canonical fragment、AGENTS bounded read、Skills catalog/显式 body、world-state fingerprint），但完整配置层 provenance、managed requirements、trust gating、enablement 和安全 filesystem adapter 尚未实现。本文件仍是 M7 的完整实现契约，不代表 M7 已完成。
> Codex 源码基线：`tmp/openai-codex-source`，commit `2c4a95736bea64256a50f7b8506bd33c181cc85a`（2026-08-27）。
> 证据边界：本地 Codex 源码是本文件中“Codex 源码事实”的依据。官方配置、AGENTS 和 Skills 页面在当前环境返回 HTTP 403，本轮没有取得网页正文，因此未用不可访问的页面补写事实。上游仓库的 `docs/config.md`、`docs/agents_md.md` 和 `docs/skills.md` 也只链接这些页面。

## 1. 结论

当前项目已有简化的 TOML、环境变量和项目指令加载，但不能视为 M7 实现。主要原因不是缺少几个配置字段，而是还没有形成以下闭环：

```text
typed config layers + per-key provenance
  -> independent managed requirements
  -> project root and trust decision
  -> AGENTS/Skills discovery through controlled filesystem reads
  -> bounded contextual fragments
  -> M6 world-state/reference-context snapshot
  -> Resume/Fork deterministic replay
```

M7 首版只实现本地 host 配置、AGENTS 和 Skills。Plugin、MCP skill provider、orchestrator/executor provider、远程安装、语义 selector 和自动脚本执行均延期，不能提前建立没有测试契约的空壳。

三类输入必须保持不同语义：

- 普通配置层提供可覆盖的值；managed requirements 是独立约束，任何配置层都不能放宽。
- AGENTS 是按目录作用域发现的项目用户指令；不可信项目的 AGENTS 不参与有效上下文。
- Skills 分成常驻的 metadata catalog、显式选中后注入的 `SKILL.md` 正文，以及按需读取的 supporting resources。不得把所有正文常驻上下文。

## 2. Codex 源码事实

### 2.1 配置

依据包括 `codex-rs/config/src/loader/README.md`、`state.rs`、`merge.rs`、`overrides.rs`、`config_toml.rs`、`skills_config.rs` 和 `project_root_markers.rs`。

1. Codex 用 `ConfigLayerStack` 表达配置，不把最终值当作唯一状态。每个 layer entry 保存 source、原始配置、稳定 version/fingerprint 和可选 `disabled_reason`。
2. 层在内部按低优先级到高优先级保存。table 递归合并，标量和数组由较高层替换；`origins()` 能解释某个 dotted key 最终来自哪一层。
3. 当前 commit 的普通层 precedence 是 packaged defaults `-10`、MDM `0`、system `10`、enterprise managed `15`、base user `20`、user profile `21`、project `25`、session flags `30`、legacy managed file `40`、legacy managed MDM `50`。具体平台来源比本项目首版更广，legacy 高优先级也不应被机械复制成新设计。
4. CLI/UI dotted-path overrides 会物化成 `SessionFlags`。它们不是需要再次合并的另一层。
5. `requirements.toml`/MDM requirements 独立于普通 layer stack；它限制允许的 approval、sandbox、network 等值，而不是用“更高优先级覆盖”模拟约束。
6. project config 从 project root 到 cwd 逐层加载，越靠近 cwd 优先级越高。未信任层仍可出现在诊断/UI 中，但带 `disabled_reason`，不进入 effective config。
7. project root 和 trust 的发现只依赖 non-project 配置，防止项目通过自己的配置改变信任根或扩大扫描范围。默认 root marker 是 `.git`；空 marker 列表关闭向父目录遍历。
8. strict config 使用完整 TOML parser 和 typed schema；未知字段、类型错误和不合法要求会产生诊断，而不是静默忽略。
9. 相对路径按定义该值的 layer 文件目录解析，不统一按进程 cwd 解析。
10. `.env` 不是 Codex 原生配置层。本项目可以保留兼容入口，但只能生成实际设置字段组成的 patch。

### 2.2 AGENTS

依据包括 `codex-rs/core/src/agents_md.rs`、`agents_md_manager.rs`、`context/user_instructions.rs` 和 `context/world_state/agents_md.rs`。

1. 每个目录的候选顺序是 `AGENTS.override.md`、`AGENTS.md`、`project_doc_fallback_filenames`。只选择第一个存在且是普通文件的候选。
2. Codex 默认候选不包含 `CLAUDE.md`。若本项目需要兼容，必须由用户显式把它配置为 fallback。
3. 文件从 project root 到 cwd 按父目录到子目录拼接，不越过确定的项目根。
4. 默认总预算是 32 KiB，预算跨所有发现文件和多环境共享。实现按字节读取并在预算处截断，再做有损 UTF-8 解码，避免 JavaScript UTF-16 字符索引破坏字节预算。
5. 每个 entry 保留 source path、environment id 和 cwd。多环境渲染会带环境标签。
6. 不可信项目完全跳过 project AGENTS；host/user instructions 仍可独立保留。
7. 文件通过 sandbox-aware filesystem API 读取，而不是直接使用不受控的 `fs` 路径拼接。
8. AGENTS 作为 `role: user` 的 contextual fragment 注入，类型为 `agents_md.instructions`，不是 system prompt 的一部分。
9. world state 保存当前 AGENTS snapshot。文件变化时生成 replacement/removal context，而不是把新旧文本不断追加。
10. AGENTS 与 Skills 是两条独立输入，不把 skill 正文拼入 AGENTS 文本。

### 2.3 Skills

依据包括 `codex-rs/skills/src/*`、`codex-rs/ext/skills/src/*`、`codex-rs/config/src/skills_config.rs` 和 `codex-rs/core/src/skills.rs`。

1. Skills 分为 metadata catalog、selected skill body 和 supporting resources。目录只常驻 name、description 和 locator；完整 `SKILL.md` 只在选中后注入。
2. 显式选择支持结构化 path/input、`$skill-name` 和带 skill path 的 Markdown mention。同名 skill 有歧义时不能靠 plain name 猜测，显式 locator 可以精确选择。
3. `SKILL.md` 必须有 YAML frontmatter 和 description；name 可缺省为目录名，最长 64 字符。单行字段会规范化空白。
4. 可选 `agents/openai.yaml` 描述 interface、tool dependencies、`policy.allow_implicit_invocation` 和 products。可选 metadata 解析失败采用 fail-open，不应使有效 `SKILL.md` 消失。
5. host roots 有 repo、user、system、admin scope，另有 plugin/executor/orchestrator provider。本项目 M7 只实现 host/local roots。
6. 上游扫描有明确边界：递归深度最多 6，每 root 最多 2,000 个目录和 20,000 个 entries，并限制 root 与 skill load 并发。隐藏目录会跳过；canonical path 是 identity，roots 先排序再按 canonical path 去重。
7. 同名 skill 不能简单相互覆盖。catalog 必须保留稳定 locator 和冲突状态。
8. `skills.config` 可按 canonical path 或 name 启停，后规则覆盖前规则。Codex 只采纳 user/session 层的 enablement rules，防止项目配置自行提升 skill 状态。
9. catalog metadata 预算默认取模型窗口的 2%，显式 `skills.max_context_tokens` 最大封顶 10,000 token；没有窗口信息时回退 8,000 characters。单项展示 description 最长 1,024 字符。
10. catalog 超预算时先保留所有 skill 的最小行，再公平轮转缩短 description；只有最小行也放不下时才省略尾部项并告警。这是 catalog 的降级算法，不是 `SKILL.md` 正文的截断算法。
11. selected body 作为 `role: user` 的 `<skill>...</skill>` contextual fragment 注入；available-skills catalog 是 developer fragment。
12. supporting files 不递归预加载，模型依照 `SKILL.md` 的路由说明按需读取。读取文件或执行 `scripts/` 仍必须走 ToolRouter、Executor、WorkspacePolicy、权限、sandbox 和审计。
13. 无效 skill 产生隔离的 error/warning，不阻止整个 session。缓存/快照需包含 cwd、roots、配置规则和文件状态，并支持明确失效或强制 reload。
14. 上游普通 host selected body 当前没有统一的 8 KiB 限制；8 KiB 出现在部分 extension resource 路径。本项目应自行定义 selected-body 单项与总预算，并明确这是本项目策略。
15. 当前稳定路径主要自动注入显式 mentions；动态 selector 仍有实验路径。不能把 catalog description 推断成已经稳定实现的自动语义路由。

## 3. 当前实现差距

以下是 M7 开始前的代码审计，不是已完成能力。

### 3.1 配置差距

- `src/config/layered-config.ts` 把 `loadConfig()` 返回的完整默认配置当作 local layer。未设置的环境变量默认值会覆盖 user/project TOML。
- `src/config/toml.ts` 是手写子集，只支持简单字符串、数字、布尔和单层 section，不支持完整 TOML。
- 未知字段被静默忽略；配置读取或解析失败只 `console.warn` 后继续，可能让安全相关配置静默降级。
- 只有一个 cwd project 文件，没有 root-to-cwd project layers、trust gating、layer version、disabled reason 或 per-key provenance。
- 没有独立 `ManagedRequirements`，也没有 session flags 的统一 typed patch。

### 3.2 AGENTS 差距

- 默认同时扫描 `AGENTS.md` 与 `CLAUDE.md`，同一目录可能注入两个文件；这不符合 Codex 的候选优先级和“每目录只选一个”。
- root markers 硬编码为 `.git/.hg/.svn`，项目配置可以解释不一致，也没有 trust decision。
- 使用同步裸 `fs` 读取，未经过统一 workspace/sandbox filesystem 边界。
- `block.slice(0, remain)` 使用 UTF-16 code unit，而 `remain` 是 UTF-8 byte 数，截断不满足字节预算。
- `PromptBuilder` 把项目指令拼入 system prompt，角色和生命周期均不正确。
- 只在 CLI 启动时加载一次；M6 world state 目前只保存一个扁平 instructions 字符串，缺少 entry provenance 和明确 replacement/removal 语义。

### 3.3 Skills 差距

当前项目没有 M7 Skills runtime。路线图只有概念条目，尚未定义 roots、scope、canonical identity、同名冲突、enablement 来源、catalog/body 双预算、错误隔离、缓存失效和 M6 replay 契约。

## 4. M7 范围与模块边界

建议新增或重构为：

```text
src/config/
  schema.ts                  # runtime schema + typed diagnostics
  loader.ts                  # ConfigLayerStack construction
  merge.ts                   # recursive merge + origins
  requirements.ts            # independent non-relaxable constraints
  project-discovery.ts       # non-project markers + trust
  env-compat.ts              # explicitly-set env patch only
  agents-md.ts               # scoped discovery and bounded reads
src/skills/
  model.ts                   # metadata, identity, outcomes, snapshots
  parser.ts                  # SKILL.md/frontmatter parser
  roots.ts                   # local host roots and scopes
  loader.ts                  # bounded discovery, diagnostics, cache
  mentions.ts                # explicit mention resolution
  catalog.ts                 # developer catalog rendering/budget
  selection.ts               # selected user fragments/body budget
```

`src/index.ts` 只做依赖组装。配置约束、项目信任和 skill 行为不能下沉到单个工具实现。所有文件读取通过可注入的、受 WorkspacePolicy 约束的 filesystem adapter，测试使用临时目录。

## 5. 配置设计

### 5.1 数据模型

```ts
type ConfigLayerKind =
  | "packaged_defaults"
  | "system"
  | "enterprise_managed"
  | "user"
  | "profile"
  | "project"
  | "env_compat"
  | "session_flags";

interface ConfigLayerEntry {
  id: string;
  kind: ConfigLayerKind;
  sourcePath?: string;
  baseDirectory: string;
  values: Readonly<Record<string, unknown>>;
  version: string;
  disabledReason?: "untrusted_project" | "outside_workspace" | "policy";
  diagnostics: ConfigDiagnostic[];
}

interface ConfigOrigin {
  dottedPath: string;
  layerId: string;
  sourcePath?: string;
  version: string;
}

interface ConfigLayerStack {
  layers: readonly ConfigLayerEntry[]; // low -> high priority
  effective: AgentConfig;
  origins: ReadonlyMap<string, ConfigOrigin>;
  requirements: ManagedRequirements;
  fingerprint: string;
}

interface ConfigDiagnostic {
  severity: "warning" | "error";
  code: string;
  message: string;
  sourcePath?: string;
  dottedPath?: string;
}
```

`version` 是 layer 原始内容和 source identity 的稳定 hash；stack `fingerprint` 包含有效 layers、origins、requirements 和 schema version。secret 的值不得进入 hash 调试输出、diagnostic、preview 或 audit。

### 5.2 普通层与约束平面

本项目首版普通层按低到高合并：

```text
packaged defaults
< system defaults
< enterprise managed defaults
< user
< optional profile
< project root ... cwd
< explicit env compatibility patch
< session flags (including parsed CLI overrides)
```

`ManagedRequirements` 在合并后单独校验并收紧 effective config：

```ts
interface ManagedRequirements {
  allowedApprovalPolicies?: readonly string[];
  allowedSandboxModes?: readonly string[];
  networkCeiling?: "deny" | "proxy" | "allow";
  writableRootCeilings?: readonly string[];
  requiredRules?: readonly unknown[];
  fingerprint: string;
}
```

要求冲突时 fail closed，返回结构化配置错误；绝不通过把 requirements 放在某个覆盖层来实现。CLI/session flags 只能在约束允许的范围内改变值。

### 5.3 加载协议

```text
load non-project layers and requirements
  -> derive root markers and trust policy
  -> canonicalize cwd and discover project root
  -> enumerate project layers root-to-cwd
  -> retain untrusted entries as disabled diagnostics
  -> parse full TOML + strict runtime schema
  -> materialize explicit env patch
  -> materialize CLI/options as one session layer
  -> merge and compute per-key origins
  -> enforce managed requirements
  -> resolve relative paths against defining layer
  -> emit immutable ConfigLayerStack
```

配置文件存在但语法错误、类型错误或含未知字段时，strict 模式必须阻止 session 启动。不存在的可选文件不是错误。M7 首版不提供“静默忽略错误配置”的兼容模式；若以后增加宽松模式，未知字段至少是可见 warning，安全字段错误仍 fail closed。

`.env`/环境变量是本项目兼容扩展。`env-compat.ts` 必须逐项检查 `process.env` 是否实际存在，只为存在项产生 patch；默认值只允许出现在 packaged defaults。`config explain <dotted.path>` 返回最终值、来源、被覆盖链和 requirement 约束，但对 secret 只显示 `<redacted>`。

## 6. AGENTS 设计

### 6.1 发现与读取

```ts
interface InstructionEntry {
  id: string;
  kind: "agents_md" | "host_user";
  sourcePath: string;
  canonicalPath: string;
  environmentId: string;
  scopeCwd: string;
  content: string;
  byteLength: number;
  truncated: boolean;
  contentHash: string;
}

interface InstructionSnapshot {
  entries: readonly InstructionEntry[];
  totalBytes: number;
  fingerprint: string;
  diagnostics: readonly ConfigDiagnostic[];
}
```

候选规则固定为：

```text
AGENTS.override.md > AGENTS.md > configured fallback filenames
```

每个目录只选一个普通文件。`CLAUDE.md` 只有出现在 non-project 配置的 fallback list 时才参与。候选去重并拒绝绝对路径、目录分隔符和 traversal。发现范围由 non-project `project_root_markers` 和 trust decision 决定；不可信 project entries 记录 skipped diagnostic，但不读取正文、不进入 snapshot。

从 root 到 cwd 顺序读取，默认共享 32 KiB 总预算。预算基于原始 bytes；超出时只读取剩余 bytes，再用 `TextDecoder("utf-8", { fatal: false })` 解码并标记 `truncated`。不能用字符串 `slice()` 模拟 byte limit。所有 canonical path、symlink 和 workspace 边界校验复用安全层，读取生成 preview/audit，但作为只读操作可自动允许。

### 6.2 上下文语义

AGENTS 渲染为独立的 `role: user` contextual fragments，并带 stable fragment type、entry id、source 和 hash。base/system instructions 保持独立，项目文件不能通过标题或伪造标签获得 system/developer 优先级。

每轮在采样前比较 `InstructionSnapshot.fingerprint`：

- 首次或 reference 缺失：注入 full snapshot。
- entry 新增或变化：注入 replacement fragment，明确旧 hash 被新 hash 替换。
- entry 删除：注入 removal fragment，明确旧指令不再有效。
- 无变化：不重复注入。

多环境使用独立 `environmentId` 和 `scopeCwd`；总预算在所有环境间共享，并保证确定性的环境/路径排序。

## 7. Skills 设计

### 7.1 数据模型与 roots

```ts
type SkillScope = "repo" | "user" | "system" | "admin";

interface SkillMetadata {
  id: string;                 // canonical path based
  name: string;
  description: string;
  canonicalPath: string;
  scope: SkillScope;
  enabled: boolean;
  allowImplicitInvocation?: boolean;
  bodyHash: string;
  diagnostics: readonly ConfigDiagnostic[];
}

interface SkillSnapshot {
  skills: readonly SkillMetadata[];
  roots: readonly { path: string; scope: SkillScope; version: string }[];
  fingerprint: string;
}

interface SelectedSkill {
  skillId: string;
  locator: string;
  body: string;
  bodyHash: string;
  explicitMention: string;
}
```

M7 首版按优先级发现以下本地 roots：

1. non-project 配置声明的 admin/system roots。
2. user root，例如 `~/.agents/skills` 和本项目保留的兼容 user root。
3. 从 project root 到 cwd 的 `.agents/skills`，仅在项目 trusted 时启用。

是否同时支持 `.codex/skills` 作为 repo compatibility root 必须成为显式配置默认值并写测试，不能散落硬编码。不同 root 先 canonicalize、排序、去重；skill identity 是 canonical `SKILL.md` path，不是 name。name 冲突保留全部 metadata，并将 plain-name resolution 标为 ambiguous。

### 7.2 有界 discovery 与解析

首版采用与源码事实一致的默认边界：递归深度 6、每 root 最多 2,000 目录和 20,000 entries、最多 8 个 root scans 和 64 个 skill loads 并发。隐藏目录不遍历。symlink 策略按 scope 显式定义：repo/user/admin 可以在 canonical path 仍满足其 root/workspace policy 时跟随，system 默认不跟随。

`SKILL.md` frontmatter 规则：开头必须为 `---`，description 必填，name 缺省为目录名，name 最长 64 字符；字段做 typed 校验和单行空白规范化。单个 skill 失败只加入 `SkillLoadOutcome.error` 并继续其他项。可选 metadata 失败只 warning，不能覆盖有效主体的 identity。

enable/disable 规则只从 user 和 session layers 读取，按配置层和声明顺序应用，后规则覆盖前规则。project skill config 不能自我启用 admin-disabled skill。规则优先匹配 canonical path；name 规则遇到冲突必须产生诊断，不能任意选择。

### 7.3 Catalog、选择与正文

catalog 是 developer contextual fragment，只含安全转义后的 name、description 和 locator。默认 metadata 预算取 context window 的 2%，显式配置最大 10,000 token；窗口未知时用 8,000 character fallback。单 description 展示上限 1,024 字符。

预算不足时：

1. 先为所有 enabled skills 保留最小 name + locator 行。
2. 在剩余预算中公平轮转分配 description，而不是让前几个 skill 占满。
3. 最小行也放不下时才按稳定顺序省略尾部，并返回 omitted count warning。

M7 只支持显式 mention。`$name` 仅在唯一匹配时选择；结构化 locator/path 可以精确选择。隐式语义匹配只记录为延期项，`allowImplicitInvocation` 不产生自动执行权限。

选中的正文渲染为独立 `role: user` `<skill>...</skill>` contextual fragment。项目策略设置两类上限：

- `skills.max_selected_body_tokens_per_skill`：单项上限。
- `skills.max_selected_body_tokens_total`：单轮所有 selected bodies 总上限。

正文超限时默认拒绝选择并给出结构化错误，不静默截断指令语义；若未来支持截断，必须有显式 marker、hash 和测试。正文、catalog、AGENTS、tools 和输出 reserve 全部进入 M6 的实际 request token accounting。

supporting resources 不预加载。skill 中引用的文件必须解析为相对 skill root 的 canonical path，并通过正常读工具；脚本必须通过 ToolRouter/Executor 的完整安全链。选择 skill 本身永远不是执行授权。

## 8. 与 M6 的集成

M7 扩展现有 `WorldStatePayload.state`，不建立平行持久化真源：

```ts
interface M7WorldStateSections {
  config: {
    effectiveFingerprint: string;
    requirementsFingerprint: string;
  };
  instructions: InstructionSnapshot;
  skills: {
    catalogFingerprint: string;
    selected: readonly Pick<SelectedSkill, "skillId" | "locator" | "bodyHash">[];
  };
}
```

同时扩展 `ReferenceContextPayload` 的 identity：

```text
instructionFingerprint
skillCatalogFingerprint
selectedSkillFingerprint
configFingerprint
requirementsFingerprint
toolLayoutFingerprint
permissionFingerprint
compHash
```

`compHash` 至少包含会改变 compaction compatibility 的 base instructions、配置 schema/version、instruction snapshot、skill catalog render policy、selected body hashes、tool layout 和 model。只影响日志展示的值不应无谓触发压缩。

规则如下：

1. 当前 filesystem/config 生成 canonical snapshot；transcript 保存 snapshot identity 和已注入 fragment records。
2. world-state full snapshot 或 merge patch表达新增、replacement 和 removal。
3. Resume/Fork 从最新 surviving checkpoint replay 当时的 baseline 与后续 patches，不重新解释旧 mention，也不重新把当前文件内容伪装成历史内容。
4. 下一次普通 turn 再比较恢复 reference 与当前 snapshot；有变化时注入明确 diff，reference 缺失时 full injection。
5. pre-turn/manual compaction 后由下一普通 turn 注入当前 full context；mid-turn 立即使用当前 canonical M7 fragments，保持 M6 对 summary 末项位置的约束。
6. selected skill 的 locator、body hash 和当轮注入结果进入 durable transcript；支持文件内容只在实际工具读取后以正常 tool output 记录。

## 9. 安全与失败语义

- project trust 在 project config 生效以及读取 AGENTS/repo skill 正文之前决定。loader 可以通过受控、限额读取解析 untrusted project config 以显示 disabled diagnostic，但其值不能参与 root/trust 推导或 effective config。项目文件不能配置自己的 root markers、trust、admin roots 或 enablement ceiling。
- 配置语法、strict schema、managed requirement 冲突属于启动失败；单个无效 skill 属于隔离 warning/error。这两类失败策略不能混用。
- 所有 discovered path 都 canonicalize 并校验 symlink。字符串前缀检查不能替代真实路径校验。
- `.git`、`.swe-agent`、`.claude`、`.codex`、`.env` 等 bypass-immune 写保护不因 skill 指令或 approval 改变。
- AGENTS 和 Skills 只能影响模型上下文，不能改变 `PermissionPolicy`、`ApprovalBroker`、`ToolPreflight` 或 sandbox enforcement。
- 诊断、provenance 和 audit 不记录 API key、完整环境变量、credential、完整 AGENTS/skill body 或 secret config value；只记录 path、hash、长度和脱敏字段。
- 配置/skill watcher 只能使 snapshot 失效；不得在 active request 中途修改不可变 request snapshot。变化在下一个 context preparation 边界生效。

## 10. 实现顺序

1. 引入完整 TOML parser、runtime schema、diagnostic 和 immutable layer stack；先修复 explicit env patch。
2. 实现 non-project root/trust discovery、project root-to-cwd layers、requirements enforcement 和 `config explain`。
3. 重写 AGENTS discovery/读取/预算，改为 user contextual fragments，并接入 M6 snapshot/diff。
4. 实现 bounded local skill discovery、frontmatter、canonical identity、错误隔离和 enablement rules。
5. 实现 catalog budget、显式 mention、selected-body budget 与 supporting-resource path resolution。
6. 把 config/instructions/skills fingerprints 接入 world state、reference context、compHash、transcript 和 Resume/Fork。
7. 完成故障注入、跨平台 path、token accounting 和端到端测试后才标记 M7 完成。

每一步保持现有 CLI 与 FakeModel demo 可运行。涉及安全、上下文或持久化的改变必须与测试同一提交交付。

## 11. 测试矩阵

### 11.1 配置

- 递归 table merge、数组/标量替换、per-key origin、relative path base directory。
- env 未设置不产生字段；只设置一个 env 不覆盖其他 user/project 值。
- root-to-cwd project layer 顺序；空 root markers；project 不能改变 root discovery。
- untrusted project layer 可诊断但不生效；trust 改变使 stack/version 失效。
- 未知字段、错误类型、坏 TOML、数值范围和 secret 脱敏。
- requirements 对 CLI/session 同样不可放宽；冲突 fail closed。
- `config explain` 的覆盖链、disabled reason 和 secret redaction。

### 11.2 AGENTS

- `override > AGENTS > fallback`，每目录只选一个；`CLAUDE.md` 默认不加载、显式 fallback 才加载。
- root-to-cwd 顺序、nested cwd、多环境标签、共享 32 KiB 预算。
- 多字节 UTF-8 边界、无效 UTF-8、空文件、普通文件检查和 deterministic warning。
- symlink 越界、workspace boundary、untrusted project 在读取前被阻止。
- full/replacement/removal fragment；重复 turn 不重复注入。
- compact -> Resume -> Fork 后 snapshot/reference 投影等价。

### 11.3 Skills

- frontmatter 必填/缺省/长度/规范化；optional metadata fail-open。
- depth、directory、entry 和 concurrency limits；隐藏目录与 symlink scope。
- canonical root 去重、同名冲突、path mention 精确选择、ambiguous name 拒绝。
- user/session enablement 规则顺序；project rule 不能提升状态。
- catalog 2%/explicit/fallback budgets、description 公平缩短、最小行与 omitted warning。
- selected body 单项/总预算；正文不常驻 catalog；supporting files 不预加载。
- script/文件操作仍经过 deny/ask/allow、approval、revalidation、runtime 和 audit。
- invalid skill 不阻止 session；cache key、file change、trust/config change 和 force reload。
- selected skill 在 compaction、Resume、Fork 和 rollback 后不丢失、不重复、不重新解释 mention。

所有 filesystem 测试必须使用临时目录，不得写项目 `.swe-agent/`、用户目录或 `tmp/openai-codex-source`。FakeModel 只证明 fragment/protocol 链路；真实 tokenizer/request shape、streaming usage 和 provider retry 需单独验证。

## 12. M7 完成标准

- `config explain` 能显示最终值、有效来源、覆盖链、disabled reason 和约束，secret 已脱敏。
- 完整 TOML 与 strict schema 生效；未设置 env 不再覆盖 user/project；managed requirements 不可被 session/CLI 放宽。
- AGENTS 候选、trust、root-to-cwd、字节预算、user-role fragment 和 replacement/removal 测试通过。
- Skills catalog/body/resources 分层成立；显式选择、冲突、预算、错误隔离和安全链测试通过。
- config、instructions 和 skills 纳入 M6 world state、reference context、compHash、token accounting 及 checkpoint replay。
- `npm run check` 通过，README 的能力描述与实际运行路径一致。

## 13. 延期项

- Plugin manifest、安装、marketplace 和第三方 provider。
- MCP/executor/orchestrator skill roots 与依赖解析。
- 自动安装或更新 skill、签名和远程信任模型。
- 稳定的隐式语义 selector、模型 shadow experiment 和自动脚本执行。
- 文件 watcher 的平台优化；首版可用显式 snapshot invalidation/mtime-hash 检查。
- 完整 Codex 多环境 host service；首版只实现当前 workspace environment，但数据模型保留 environment id。

延期项不得以空目录、空接口或“已支持”文案提前进入实现状态。
