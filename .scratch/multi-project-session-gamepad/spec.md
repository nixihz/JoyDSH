# 多项目与多会话并发管理（PS5 交互风格）

Status: resolved
Label: ready-for-agent

## 目标

借鉴 PlayStation 5 主机界面交互与人体工学，支持多项目与多会话并发管理，并为手柄操作提供原生的肩键 L1 / R1 切换项目、上下/左右空间导航切换会话以及快捷新建。

## 范围

- **肩键项目切换**：支持手柄 Button 4 (L1) / Button 5 (R1) 以及键盘 `[` / `]` 在多个已加载项目之间快速循环切换。
- **空间会话导航**：在活动区域呈现 PS5 风格的会话快捷条（Session Chips / Activity Cards），支持方向键上下/左右在项目栏、会话栏、输入区与检查器之间无缝穿梭。
- **快捷新建**：支持快捷键 `△`（手柄三角键 / 键盘 `Cmd/Ctrl+N`）快速新建会话，支持 `Cmd/Ctrl+Shift+N` 或项目栏末尾快捷卡片新建项目。
- **后台多会话并发投影**：将前端事件投影结构升级为字典结构 `projections: Record<string, TaskProjection>`，多任务并发事件流通过 `event.taskId` 精确分发，后台项目/会话执行状态（执行中 🟢、待审批 🟡 等）实时更新。
- **PS5 主机美学与控制器 HUD**：顶栏 Project Ribbon、霓虹青高亮环、脉冲指示灯、按键图示 (`[L1]`, `[R1]`, `[△]`, `[✕]`, `[◯]`, `[Options]`) 以及底部常驻操作 HUD。

## 验收标准

1. 手柄 L1 / R1 与键盘 `[` / `]` 可循环切换项目。
2. 方向键支持 4 层空间焦点图：顶栏操作 -> 项目栏 -> 会话栏 -> 输入框/检查器。
3. 支持点击或快捷键新建会话和新建项目。
4. 后台任务接收事件时实时更新对应会话的投影与状态指示灯。
5. 所有单元测试、TypeScript 类型检查及桌面构建 100% 通过。

## Answer

已完成多项目+多会话并发管理与 PS5 交互手柄适配：
1. `packages/input` 新增 `previous-project`, `next-project`, `previous-session`, `next-session`, `new-session`, `new-project` 语义动作及按键映射。
2. `apps/desktop/src/app-focus.ts` 构建 4 层空间焦点拓扑图，支持水平项目条与会话卡片以及纵向区域穿梭。
3. `apps/desktop/src/App.tsx` 升级多任务并发投影管理与事件分发，渲染顶栏 PS5 Project Ribbon、Session Quickbar 以及底部 PS5 Controller HUD。
4. `apps/desktop/src/styles.css` 落地 PS5 霓虹青高光环、半透明毛玻璃、按键徽章与脉冲动画。
5. 运行全部测试通过（10 个测试文件，74 个用例），Typecheck 和 Build 均顺利通过。
