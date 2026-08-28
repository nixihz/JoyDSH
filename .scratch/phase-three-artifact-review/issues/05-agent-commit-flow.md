# 智能体提交闭环

Type: task
Status: resolved
Blocked by: 02, 03, 04

## Scope

基于同一服务端快照构造已接受成果上下文，请求智能体生成提交说明，在用户确认后仅提交该任务已接受的变更。

## Answer

已实现完整的智能体提交流程（`request_task_commit_proposal`、`resolve_task_commit_proposal`、`commit_task_artifacts`），支持基于同一服务端快照生成精准 commit message，在用户确认后通过 Commit Bridge 精确且仅提交已接受的文件成果，并妥善保留未接受工作区文件。
