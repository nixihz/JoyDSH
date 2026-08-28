# 状态事件投影

Type: task
Status: resolved

## Scope

通过 `projectTaskEvent` 将 DSH 回合结束原因映射为可见领域状态。

## Comments

- 2026-08-27：已从 DSH 0.1.1-rc.2 类型声明与真实 `session.history` 确认事件结构。

## Answer

`projectTaskEvent` 现在区分完成、取消、受阻、输出截断、中断与失败，并保留实时/历史统一投影。
