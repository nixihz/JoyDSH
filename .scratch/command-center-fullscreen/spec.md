# 命令中心全屏切换功能规格

## 目标
在 JoyDSH 命令中心（Command Center）菜单中新增“进入全屏” / “退出全屏”切换菜单项，实现手柄/键盘无障碍导航支持，并在桌面（Tauri）与浏览器（Web）环境下均能稳定切换和同步窗口全屏状态。

## 交互设计
1. **菜单项位置**：位于“回滚任务成果”之后、“模型设置”之前。
2. **状态感知**：
   - 未全屏：展示 `Maximize` 图标、主标题“进入全屏”、副标题“全屏显示工作空间”。
   - 已全屏：展示 `Minimize` 图标、主标题“退出全屏”、副标题“恢复窗口显示”。
3. **焦点系统**：
   - 节点 ID: `command-fullscreen`。
   - 上下环形导航：向上连接前一个菜单项，向下连接 `command-model-settings`。
4. **跨端适配**：
   - Tauri 环境：调用 `@tauri-apps/api/window` 的 `isFullscreen()` 与 `setFullscreen()`，并在 capability 中赋予 `core:window:allow-set-fullscreen` 权限。
   - Web 环境：调用标准的 Fullscreen API（`requestFullscreen` / `exitFullscreen`）并监听 `fullscreenchange` 与 `webkitfullscreenchange`。
