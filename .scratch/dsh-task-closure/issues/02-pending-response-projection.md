# 待回应任务投影

Type: task
Status: resolved
Blocked by: 01

## Scope

通过 `projectTaskEvent` 分别投影和清除待处理问题与方案审阅，并形成统一等待状态。

## Comments

## Answer

`projectTaskEvent` 已分别投影普通问题与方案审阅，按请求句柄去重并在 `question/resolved` 后清除；任一待处理项都会进入 `waiting-response`，且运行状态同步不会覆盖等待回应状态。
