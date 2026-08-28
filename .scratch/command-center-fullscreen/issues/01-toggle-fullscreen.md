# 01 - 命令中心全屏切换菜单项

Status: resolved
Type: task

## 描述
在命令中心增加进入和退出全屏的菜单项，支持 Tauri 桌面端与 Web 端的全屏切换与状态监听，并与无障碍焦点图打通。

## 验收结果
- [x] 创建跨端全屏服务 `fullscreen-service.ts` 及单元测试 `fullscreen-service.test.ts`。
- [x] Tauri 权限配置添加 `core:window:allow-set-fullscreen`。
- [x] 焦点图拓扑 `app-focus.ts` 注册 `command-fullscreen` 节点并保证上下焦点环形链接。
- [x] 主界面 `App.tsx` 动态响应全屏状态，展示进入/退出全屏文案与对应图标。
- [x] 单元测试 `App.test.ts` 及全量测试套件通过（66 tests passed）。

## Answer
已完成跨环境全屏服务与命令中心菜单项集成，支持全屏切换与状态动态同步。
