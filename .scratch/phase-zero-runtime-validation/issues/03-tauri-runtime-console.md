# Tauri 运行时控制台

Type: task
Status: resolved
Blocked by: 01, 02

实现受管 DSH 进程和阶段零单屏 React 验证界面。

## Comments

## Answer

已实现阶段零单屏控制台和 Rust 受管进程。DSH 固定监听 127.0.0.1:43127，使用应用专属 DSH_HOME；一元 RPC 与双事件流由 Tauri 代理，窗口销毁时停止并回收子进程。760×600 最小视口无横向溢出。
