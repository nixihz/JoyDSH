# 任务基线与差异检查

Type: task
Status: resolved

## Scope

为新任务持久化 commit-backed Git 基线，并在回合停止后返回结构化文件差异；恢复任务只读取已有基线。

## Answer

Rust 已实现工作区验证、任务基线、结构化差异、资源上限和持久化存储；Tauri 与 TV 检查器已接入动态、变更、成果三页。
