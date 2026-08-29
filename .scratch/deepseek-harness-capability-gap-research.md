# DeepSeek Harness 0.1.1-rc.2 能力差距研究

研究日期：2026-08-29
研究对象：`@deepseek-ai/dsh@0.1.1-rc.2` / Git tag `dsh-v0.1.1-rc.2`（commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`）

## 结论摘要

JoyDSH 启动的是 DSH 完整的 `web` profile，而不是一个精简 SDK。因此，多数高价值能力已经随运行时装载，当前差距主要在 JoyDSH 自有适配层、领域投影和手柄友好 UI 没有显式接通。

建议优先顺序：

1. 结构化问用户（否则真实 Agent 可能在等待输入时缺少可用交互）。
2. 子代理、后台作业和工作流的可见性与控制。
3. 运行中 `steer` 与输入队列管理。
4. DSH 原生 Plan Mode 与持久 Goal 生命周期。
5. 会话 fork、rename、搜索、引用与完整历史分页。
6. Agent Preset / Code Mode、完整模型目录与 reasoning effort。

另有一组能力只是存在于 DSH 包或上游仓库，并未由默认 `web` profile 挂载（例如 Schedule、MCP、LSP、Codex hooks、ACP、E2B）。这些不能算“后端已启用”，需要 JoyDSH 建立自己的 profile/patch 后才能集成。

## 研究方法与版本依据

- npm registry 返回该版本的官方仓库为 `deepseek-ai/deepseek-harness`，包目录为 `apps/cli`；本地包的 `package.json` 与之相同。[npm 包页](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.1.1-rc.2)；[官方 tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.1-rc.2)
- 以 tag 对应源码、包内 README、默认 Cordis 配置为上游事实来源，并以 JoyDSH 当前代码确认是否已有 RPC、领域类型、事件投影或 UI。
- 这是静态集成审计，没有对运行中的 JoyDSH 做逐 RPC 探测。结论中的“已装载”来自 JoyDSH 的启动参数和 DSH 官方 `web` profile 组合；“未接入”来自适配器/API 与投影/UI 的代码面。

## 当前集成边界

JoyDSH 固定启动 `dsh --profile web --host 127.0.0.1 --port 43127 --no-open`，并使用应用专属 `DSH_HOME`。这证明默认 Web host/agent 插件会被加载，但 JoyDSH 使用自己的 Tauri/React UI，而不是官方 Web 客户端。[JoyDSH runtime 启动](../apps/desktop/src-tauri/src/lib.rs#L726-L750)；[DSH profile 说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/apps/cli/README.md)

JoyDSH 的 `DshAdapter` 目前只显式包装健康检查、会话 list/create/history/prompt/attachment/cancel、权限与审批、凭据/设置、模型配置/选择、两路事件订阅；健康信息还静态只声明五项 capability。[适配器接口](../packages/dsh-adapter/src/index.ts#L167-L185)；[健康声明](../packages/dsh-adapter/src/index.ts#L212-L218)

会话投影只专门处理消息、`todo/write`、权限、审批和运行状态。其他 DSH 领域事件虽然可能进入通用事件列表，但不会形成可操作的产品状态。[JoyDSH 任务投影](../packages/task-projection/src/index.ts#L105-L271)

## 已由 Web profile 装载，但 JoyDSH 尚未显式产品化

### 1. 结构化问用户

**DSH 能力。** Base bundle 装载 `dsh-user-questions`，标准 preset 装载模型工具 `dsh-tool-ask-user`，官方 Web 又提供 `ui-user-questions`。Plan Mode 的退出审阅也复用同一提问通道，而不是普通工具审批。[base 配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/bundle/base/cordis.patch.yml#L53-L56)；[standard preset](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/apps/cli/config/agent-presets/standard/agent.cordis.yml#L236-L240)；[Web UI 配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/bundle/web-app/cordis.patch.yml#L287-L295)；[Plan review 语义](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/plan/plan-mode/README.md#model-and-human-interactions)

**JoyDSH 差距。** 当前只有工具 approval 的领域类型和 `/api/respond` 路径，没有结构化 question 的题目、选项、取消/回答状态及专用 UI。[审批回应实现](../packages/dsh-adapter/src/index.ts#L309-L333)

**价值/风险。** 这是最高优先级的正确性缺口。Agent 调用 `ask_user_question` 或提交计划审阅时，JoyDSH 需要区分“工具授权”和“用户决策”，否则可能表现为通用事件、无法回答或流程停住。

### 2. 子代理、后台作业、工作流与 Ralph

**DSH 能力。** 标准 preset 默认提供可继续的 spawn/fork 子代理、`send_message` / `list_agents` 等控制、后台 job 注册与控制、可并行 fan-out 的 JavaScript workflow，以及最多多轮尝试的 Ralph 工具。子代理契约支持具名 provider 和持久 child descriptor；workflow 会投影独立的 run/phase/agent lifecycle。[standard preset delegation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/apps/cli/config/agent-presets/standard/agent.cordis.yml#L157-L234)；[Subagent 服务](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/subagent/subagent/README.md)；[Workflow 服务](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/workflow/workflow/README.md)；[后台 Jobs](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/jobs/jobs/README.md)

官方 Web 已挂载 workflow run、subagent 和 jobs 三类 UI。[Web UI roster](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/bundle/web-app/cordis.patch.yml#L225-L263)

**JoyDSH 差距。** 适配器没有 `subagent.list/history/prompt/interrupt` 或 job/workflow 方法，投影也没有 child tree、后台进程状态、workflow phase/log。相关事件最多落入通用动态列表，无法继续子代理、终止子代理、读取 child history 或管理后台命令。

**建议。** 先接只读可见性（树、状态、来源 session、workflow 进度），再加入 interrupt/follow-up/collect；这些操作应保持 DSH 的 owner/lineage 权限，而不是只按可预测 id 操作。

### 3. 运行中 steer 与输入队列编辑

**DSH 能力。** Agent inbox 区分排队的普通 prompt 与对运行中回合生效的 steering；核心事件包含 `steering/message`。Host API 明确定义 `session.prompt` 的 `queue | steer` 模式，以及可编辑、删除或严格提升为 steer 的 `session.updateQueue`。[Host Session API](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/host/apiproxy/src/api/sessions.ts#L320-L370)；[Session 事件词汇](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/docs/subsystems/session.md#sessioneventmap--the-event-vocabulary)

**JoyDSH 差距。** `sendInput()` 永远发送 `mode: 'queue'`，没有运行中 steer、排队消息列表、编辑或撤销入口。[JoyDSH sendInput](../packages/dsh-adapter/src/index.ts#L248-L279)

**价值。** 对电视/手柄界面尤其重要：用户看到 Agent 走偏时应能快速纠偏，而不必取消整回合或等待当前长任务完成。

### 4. 原生 Plan Mode 与持久 Goal

**DSH 能力。** Plan Mode 是持久化、逐 Agent 的协作状态，带 `/plan`、`/plan off`、稳定的 `exit_plan_mode` schema 和用户审阅；状态可在 resume、fork、compaction 后恢复。[Plan Mode README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/plan/plan-mode/README.md)

Goal 是同一 session 内事件溯源的长期目标，支持 create/edit/pause/resume/complete/block/clear 和 compare-and-set revision；goal-round driver 会在 Agent idle 后自动追加下一轮，直到完成、阻塞、暂停或达到轮数上限。[Goal README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/goal/goal/README.md)；[Goal round driver](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/goal/goal-round-driver/README.md)

**JoyDSH 差距。** 当前“计划”只是把 `todo/write` 投影成三态清单，并不等价于 Plan Mode；没有 plan enter/exit/review 状态，也没有 GoalBar、目标 revision/phase、暂停/恢复或自动轮次控制。[todo 投影](../packages/task-projection/src/index.ts#L219-L223)

**建议。** UI 中应把三个概念分开：实施 todo（任务内步骤）、Plan Mode（变更前方案审阅）、Goal（跨多轮自动推进目标）。

### 5. 会话高级管理：fork、rename、搜索、引用、导出与分页

**DSH 能力。** Session 核心支持在稳定 turn boundary 从历史位置 fork；session-query 提供会话/事件读取、过滤、surface、lineage trace 与 full-text provider seam；session reference 可把另一会话的有界快照作为不可信上下文插入当前会话；Web bundle 还装载 ZIP 会话日志导出。[Session fork](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/docs/subsystems/session.md#live-session-fork-api)；[Session Query](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/session-query/session-query/README.md)；[Session Reference](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/context/session-reference/README.md)；[Session Export](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/session-query/session-log-export/README.md)

**JoyDSH 差距。** Adapter 没有 fork、rename、search、reference、export；本地“归档”只是 JoyDSH 侧隐藏 task id，不是 DSH workspace 的归档/排序语义。`replayTask()` 只调用一次 `session.history`，schema 虽读取 `hasMore`，却不继续分页，长会话会得到不完整历史。[单页历史实现](../packages/dsh-adapter/src/index.ts#L241-L245)

**重要限定。** 默认 Web profile 将 `session-query-sqlite.openAt` 设为 `never`，所以标题/workspace 级搜索与精确读取可用，但正文全文索引默认关闭。要做全文搜索，JoyDSH 需增加 profile patch（通常设置 `openAt: first-search` 并指定持久 SQLite 路径）。[Web 搜索默认值](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/bundle/web-app/cordis.patch.yml#L25-L33)

### 6. Agent Preset、Code Mode 与自定义 Agent

**DSH 能力。** 每个 session 可以选择一套独立 Agent composition；blank session 可切换 preset，用户可从系统 preset 复制、编辑、删除自定义 preset。官方随包提供：

- `standard`：完整编码 Agent。
- `code`（PTC 模式）：只向模型呈现 `run_code` 和生成的 TypeScript SDK，使多步工具调用可在一次程序中组合。
- `minimal`：持久 PTY shell + `str_replace_editor` 的极简双工具 Agent。
- `cordis`（创造模式）：让 Agent 检查、临时扩展实时 Harness，并创作新的 preset。

来源：[Preset 服务与 authoring](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/preset/agent-presets/README.md)；[Code Mode presentation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/core/agent-tool-presentation/README.md)；[官方 preset 目录](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.1-rc.2/apps/cli/config/agent-presets)

**JoyDSH 差距。** `session.create` 不传 preset，任务摘要也丢弃 `agentPreset`；没有 roster/list/select/copy/read/remove 和默认 preset 设置 UI。用户实际上一直使用默认 `standard`，无法利用 PTC、极简或创造模式。[JoyDSH createTask](../packages/dsh-adapter/src/index.ts#L228-L239)；[摘要映射](../packages/dsh-adapter/src/index.ts#L518-L526)

**安全注意。** 用户 preset 是可执行 composition，官方明确要求按 shell access 的信任级别对待；`cordis` 模式的临时插件 VM 也不是安全边界。JoyDSH 不应把 preset 导入包装成无风险主题选择。

### 7. 完整模型目录、每会话 route 与 reasoning effort

**DSH 能力。** 官方客户端从 `session.models` 读取按 provider 分组的可用模型、失败信息、context/window 限制与模型支持的 reasoning effort，再做每 session 选择；route 会被写入可重放 request header。[Web model-selection 源码目录](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.1-rc.2/packages/client/ui-model-selection)；[请求 header](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/docs/subsystems/session.md#the-request-header-event-requestheader)

**JoyDSH 差距。** Adapter 虽实现 `llm.discoverModels` 并在 selection 类型上允许 `reasoningEffort`，App 没有调用模型发现，当前只产品化 DeepSeek/OpenAI，且不会提交 reasoning effort。[发现与选择](../packages/dsh-adapter/src/index.ts#L372-L405)

### 8. Slash command、Skill 与 `@` 引用发现

**DSH 能力。** 官方 Web 有 `/` 和 `@` 触发管线、命令目录、Skill 目录/加载器、文件引用、会话引用和子代理引用。文件系统 Skill provider 会扫描项目级和用户级 `SKILL.md`，监听新增/删除/修改，并支持模型可调用与用户可调用的独立策略。[Web input roster](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/bundle/web-app/cordis.patch.yml#L240-L255)；[Skill discovery](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/skill/skill-filesystem/README.md)

**JoyDSH 差距。** 原始文本可透传 `/permission` 等命令，但没有命令/Skill 发现、参数化选择、引用 picker 或专用结果体验。这使 DSH 的可发现能力依赖用户记住内部命令名。

### 9. 语义化工具呈现、Trajectory 与 workflow timeline

**DSH 能力。** ToolDefinition 可返回纯函数式 UI presentation metadata；官方 Web 展示嵌套工具调用树、专用 tool card、workflow 生命周期节点和 trajectory，而不是只展示工具名/原始参数/文本结果。[工具 presentation 契约](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/docs/subsystems/tools.md)；[Web tool/workflow roster](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/bundle/web-app/cordis.patch.yml#L216-L229)；[Trajectory UI](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.1-rc.2/packages/client/ui-trajectory)

**JoyDSH 差距。** History schema 只保留原始 `event`，TaskInspector 对 `tool/call` 和 `tool/result` 使用通用摘要，没有消费 host 计算的 view、嵌套 Code Mode subcall 或 trajectory 状态。[历史 schema/转换](../packages/dsh-adapter/src/index.ts#L529-L539)；[通用工具动态](../apps/desktop/src/TaskInspector.tsx#L590-L618)

### 10. 上下文计量、自动/手动压缩、会话统计与消息反馈

**DSH 能力。** Base bundle 装载 token meter、自动 compaction、超大 tool result pruner 和 `/compact`；Web bundle装载 turn/step session stats，以及每条 assistant message 的 Like/Dislike + 可选备注。反馈 RPC 为 `messageFeedback.list/put/delete`，带 compare-and-set version。[base compaction 配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/bundle/base/cordis.patch.yml#L281-L303)；[Web stats/feedback 配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/bundle/web-app/cordis.patch.yml#L64-L91)；[Message Feedback RPC](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/feedback/message-feedback/README.md#service-and-host-remote-contract)

**JoyDSH 差距。** 没有上下文占用、压缩触发/记录、turn-step 统计或反馈接口/UI。自动压缩仍会在运行时发生，但用户无法感知为何早期上下文被替换，也无法主动压缩。

## DSH 支持但默认 Web profile 未挂载的扩展

这些能力需要 JoyDSH 自定义 profile/plugin patch，不能只加前端按钮。

| 能力 | DSH 0.1.1-rc.2 状态 | JoyDSH 缺口 | 一手来源 |
|---|---|---|---|
| Durable Schedule | 包随顶层 `@deepseek-ai/dsh` 发布，但 base/web patch 没有该 row；提供 session-local 的一次性/绝对时间/固定间隔提醒 | 自定义 profile 挂载、管理 UI；还需接受“仅原 session live 时准时触发”的限制 | [Schedule README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/schedule/schedule/README.md) |
| MCP client | 顶层包含 `dsh-mcp-client` 依赖，但默认 profile 未配置 server | MCP server 配置、凭据/权限、工具来源呈现与生命周期管理 | [MCP package](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.1-rc.2/packages/mcp) |
| LSP 精确导航 | 上游有 `goToDefinition/findReferences/goToImplementation/hover` 的只读 `lsp` 工具，但非默认 bundle | provider/server 生命周期、语言路由、专用结果 UI | [LSP tool](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/lsp/tool-lsp/README.md) |
| Codex/Claude Code hooks 兼容 | 上游提供 hooks bridge；Codex bridge 只覆盖 10 个 hook 中的 5 个，属于兼容路径而非完整实现 | 明确信任边界、按 workspace 选择配置，并接受上游列出的部分语义 | [Codex hooks](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/hooks/hooks-codex/README.md) |
| ACP 自动化入口 | 上游有 JSON-RPC stdio ACP server，可创建 fresh Agent、发送文本/图片、审批与取消 | 独立 automation profile/进程管理；它不是交互 UI 替代品且不支持 resume/fork | [ACP README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/acp/acp/README.md) |
| E2B 远程 sandbox | 上游有 E2B fs/subprocess 适配器 POC，状态临时且并非整个 Harness 在远端 | 凭据、网络策略、workspace 同步、生命周期与成本策略 | [E2B README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/packages/e2b/e2b/README.md) |
| Headless / 自定义 profile / plugin 管理 | CLI 原生支持 headless 单次任务、profile patch 分层与 `dsh plugin --profile ...` | JoyDSH 启动参数硬编码 `web`，没有 profile 选择、插件清单/配置或 headless job 入口 | [CLI README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.1-rc.2/apps/cli/README.md)；[JoyDSH 启动](../apps/desktop/src-tauri/src/lib.rs#L733-L749) |

## 建议的集成切片

### 第一批：补齐交互正确性

- 给 Adapter 增加 structured question 的请求/响应契约，领域层区分 Question 与 Approval，做手柄可操作的单选/多选/自由文本 Sheet。
- 接 `steer` 与 queue mutation，至少支持“立即纠偏”和“撤销尚未执行的输入”。
- 修复 `session.history` 分页，避免后续任何领域投影建立在截断历史上。

### 第二批：让多 Agent 工作可观察、可控制

- 接 subagent tree、history、follow-up、interrupt，以及 jobs 状态与 kill/read/wait。
- 独立呈现 workflow run/phase/child，不把它们压成通用 tool result。
- 为 Goal 建立 revision-fenced 操作，Plan review 复用第一批的 Question UI。

### 第三批：发挥 DSH 的可组合差异

- 新建任务时选择 Agent Preset，优先开放 `standard` 与 `code`；`minimal`/`cordis` 需要更强的风险说明。
- 加 session fork/rename/reference/export 与 DSH 原生 workspace archive/order。
- 消费 `session.models` 与 reasoning efforts，不再硬编码模型目录。
- 设计 JoyDSH 专属 profile patch，再决定是否启用全文索引、Schedule、MCP、LSP、hooks 或 ACP。

## 不应误报为缺失的能力

- 图片附件：JoyDSH 已接输入、持久 attachment 读取和消息图片投影。
- 双权限 preset 与工具审批：JoyDSH 已做 `workspace-write` / `danger-full-access` 和 TV 审批流，虽然还没接结构化 Question。
- Todo 计划：JoyDSH 已投影 `todo/write`，但它不等于 DSH Plan Mode。
- 文件变更评审、原子回滚和 Agent commit bridging：这是 JoyDSH 自己的产品能力，不属于需要从 DSH 官方 Web UI 搬运的缺口。
