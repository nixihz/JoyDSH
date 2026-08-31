---
name: joydsh-dev-workflow
description: 面向 JoyDSH（Tauri + React + Rust 手柄优先智能体工作空间）的开发工作流。覆盖动手前的领域文档阅读、pnpm/cargo 命令矩阵、问题跟踪器约定、统一语言、TV 风格设计规则、测试与构建验证、CHANGELOG/CONTEXT 维护，以及 main 分支保护与 PR 流程。当用户要求在 JoyDSH 仓库内实现、修复、重构、审查、跑构建或测试，或询问仓库约定时加载。
---

# JoyDSH 开发工作流

本 skill 把 `AGENTS.md`、`CONTEXT.md`、`DESIGN.md`、`docs/agents/*` 中分散的约定压成一条可执行链路，只保留**真正改变下一步动作**的部分。需要细则时跳到对应文件全量阅读，不要在这里复述。

## 0. 项目一句话

JoyDSH 是一个 pnpm monorepo 下的 Tauri 桌面应用：Rust 后端 + React/TypeScript 前端，运行 DSH 智能体，前端在 `127.0.0.1:43127` 启动；面向手柄 + 键盘的 TV 风格工作空间。

工具链固定：Node 22.22.3 · pnpm 10.20.0 · Rust 1.88.0 · DSH 0.1.1-rc.2 · Tauri CLI 2.11.4。

## 1. 动手前必读（按顺序）

1. `CONTEXT.md` — 统一语言表（工作空间/任务会话/待回应/方案模式/前台任务 等）。所有命名、commit、PR 标题、issue 标题必须用这里定义的术语，**禁止使用**其下"避免使用"列里的同义词。
2. `docs/adr/` — 只读与本次工作相关的最新几份（文件名带序号）。如果改动与已有 ADR 冲突，必须在回复里点明，**不得静默覆盖**。
3. `DESIGN.md` — 当前任务涉及 UI 时全量读完；否则跳过。
4. `docs/agents/domain.md` — 单语境布局与 ADR 冲突处理的总则。

## 2. 关键路径

- 桌面应用入口：`apps/desktop/`（Vite + React + Tauri）
- Rust 运行时：`apps/desktop/src-tauri/`
- 共享 TS 包：`packages/{domain,dsh-adapter,focus,input,task-projection}/`
- 本地问题跟踪器：`.scratch/<feature>/{spec.md,issues/,map.md}`
- 用户面向变更日志：仓库根 `CHANGELOG.md`
- 焦点图与手柄导航核心：`apps/desktop/src/app-focus.ts`、`semantic-navigation.ts`

## 3. 命令矩阵

| 目的 | 命令 |
| --- | --- |
| 装依赖（保持锁文件不变） | `pnpm install --frozen-lockfile` |
| 仅前端开发热更 | `pnpm dev:web` |
| 桌面应用开发态（启 Tauri） | `pnpm dev` |
| 类型检查 | `pnpm typecheck` |
| 前端测试 | `pnpm test` |
| Rust 单元/集成测试 | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` |
| Rust 编译验证（不跑测试） | `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` |
| 桌面构建（生成 .app/.dmg/.msi） | `pnpm build:app` |

`build:app` 会先触发 `tsc && vite build` 再调 `tauri build`，全程约 3-6 分钟；不要中途打断，Rust 增量缓存命中后会快很多。

## 4. 问题跟踪器（`.scratch/`）

- 目录布局：`.scratch/<feature>/spec.md` + `issues/NN-<slug>.md` + `map.md`。
- 任务文件顶部 `Status:` 取值 `claimed` / `resolved`；`Type:` 取值 `research` / `prototype` / `grilling` / `task`；依赖用 `Blocked by: 01, 03`。
- 领取任务前先 `claimed`；完成后追加 `## Answer`、把 `Status` 改 `resolved`，并在 `map.md` 登记上下文链接。
- 不要把外部 issue tracker（GitHub Issues 等）混进 `.scratch/`；本仓库约定是本地 Markdown。

## 5. 领域语言与命名铁律

引用 `CONTEXT.md` 中的术语而不是近义词：

- "任务会话" ≠ 聊天/线程/对话
- "待回应" ≠ 待审批/统一审批（聚合审批、问题、方案审阅，但不改语义）
- "方案模式" ≠ 计划模式/只读模式
- "执行清单" ≠ 计划/方案
- "前台任务" / "后台任务" ≠ 活跃聊天/最小化窗口
- "工作空间" ≠ 桌面/首页/仓库浏览器

如果需要一个尚未在 `CONTEXT.md` 的概念，先判断是不是误用了现有语言；确实有缺口时直接走 `domain-modeling` 技能补到 `CONTEXT.md`，不要在代码里自创术语。

## 6. 前端设计硬约束（涉及 UI 时）

- 深色中性底 + 青/绿/黄/红语义色；圆角 ≤ 6px。
- 控件需同时支持键盘与手柄；高频非文本操作必须进入 managed focus graph（`semantic-navigation.ts`、`app-focus.ts`）。
- 危险操作必须用颜色 + 层级区分，**不能只靠位置**。
- 状态（运行/等待/成功/失败/不可用）必须同时有文字或图标，不能只靠颜色。
- 弹层/命令中心只承载临时决策；主任务区是视觉重心，隐藏任务检查器后主任务区占满剩余空间。
- 改动后自查：键鼠 + 手柄三种输入路径；焦点进入/移动/恢复；桌面与窄屏溢出；六种状态（加载/空/成功/失败/禁用/等待回应）；图标 `aria-label` 与对比度。

## 7. 文件与函数粒度

- 新文件 ≤ 250 行；超 300 行的文件继续加逻辑前先拆。
- 函数 ≤ 40 行；超 60 行必须拆。渲染/请求/worker 主流程禁止把数据读取、校验、状态变更、HTML 拼接、副作用揉在一起。
- 模板字符串、长分支、重复 fetch/响应逻辑抽出小函数。
- 数据/类型/生成文件/测试夹具不计入行数，但仍要单一职责。

## 8. 验证清单（提交前自查）

至少执行与改动范围匹配的部分，并实际运行，**不要声称未跑的检查通过**：

1. 受影响包：`pnpm --filter <pkg> typecheck`
2. 前端：`pnpm test`（vitest，全量约 1s）
3. Rust 端：触及 `apps/desktop/src-tauri/` 时跑 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`（首次 2-3 分钟，增量 5-30s）
4. 涉及打包：可跑 `pnpm build:app` 验证
5. 涉及 UI：手柄 + 键盘 + 鼠标三路分别过一遍
6. 受权限、签名、外部依赖、CI 等因素无法验证时，必须在交付说明里点名未验证项与风险

## 9. 变更与文档维护

- 任何**面向用户**的 feature 必须在 `CHANGELOG.md` 的 `## Unreleased` 下加一条简洁、面向结果的记录（不是 commit 流水）。同一 feature 的多条提交合并成一条。
- 改动引入/修改了领域术语、实体边界、生命周期、状态转换、业务不变量或职责归属时，必须更新 `CONTEXT.md`；纯技术变更（重构、格式、依赖）不需要。
- 涉及架构取舍的决策先看 `docs/adr/` 是否已有同类条目；没有时按 ADR 模板新增并放对序号。
- 自动生成文件（`* 自动生成`、`.gen/`、lockfile、icon 资源）通过其生成源更新，不手动改。

## 10. Git 与分支保护

- 仓库默认分支是 `main`，合并会自动触发线上部署；**绝不在 main 上直接开发或 push**。
- 所有改动走 feature 分支 + PR；commit 摘要用中文，遵循 Conventional Commits 风格（`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:`，scope 用包名，如 `feat(desktop): …`）。
- 未经用户明确要求，不 commit / push / force-push / 创建 PR / 合并 PR。
- 用户说"提 PR"时按 `AGENTS.md` §"PR 提交流程"：fetch -p → rebase origin/main → 验证 → push（rebase 后用 `--force-with-lease`）→ 更新或创建 PR。

## 11. 环境变量与敏感信息

- 真实 `.env`、密钥、证书、DSH 鉴权不进仓库；不写入日志、截图、commit、PR 描述或回复。
- 新增环境变量必须同步更新示例配置或环境变量文档（用途、是否必填、默认值、暴露范围）。
- DSH 路径可通过 `JOYDSH_DSH_BIN` 显式指定，默认使用随包安装的二进制；运行时绑死 `127.0.0.1:43127`，使用应用专属 `DSH_HOME`。

## 12. 决策与 GRILL

- 目标清晰、影响局部、可逆、已有惯例可循：直接实现，不提澄清问题。
- 只有关键决策会显著改变产品行为、领域边界、架构、数据模型、外部契约、迁移方案或安全风险，且无法从上下文可靠判断时，才启动 GRILL（`grill-me` / `grill-with-docs`）。
- 涉及领域术语、生命周期、不变量、ADR、术语表沉淀时直接用 `grill-with-docs`，不要拆开调其他 GRILL 技能。
- 一次 GRILL 只问真正阻塞决策的最小问题集，优先给选项 + 影响 + 推荐。
- 更新 `CONTEXT.md` 不以启动 GRILL 为前提；发现领域语言需要沉淀时直接用 `domain-modeling`。

## 13. 反模式（不要做）

- 在 `main` 直接改代码或 push。
- 提交时把 commit 信息写成英文/纯流水账。
- 改完只跑 `pnpm test` 就声称"全过"，忽略 Rust 端。
- 引入第二套工具链（nvm 之外的 Node 管理、cargo 之外的 Rust 管理、pnpm 之外的包管理器）。
- 在 PR 描述、commit、回复里贴真实密钥或 DSH 鉴权信息。
- 静默覆盖 `docs/adr/` 里已有的决策。
- 在没有 `domain-modeling` 流程的情况下自创领域术语。
- 把 GitHub Issues / Linear 之类的外部 tracker 状态写进 `.scratch/`，或反过来。
