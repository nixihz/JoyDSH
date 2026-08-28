# 结构化计划投影

Type: task
Status: resolved
Blocked by: 01

## Scope

通过 `projectTaskEvent` 投影 `todo/write` 的全量计划快照。

## Comments

## Answer

新增 `TaskPlanItem` 与 `plan` 投影，使用最新合法 `todo/write` 全量快照替换计划。
