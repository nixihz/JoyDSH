# 权限与审批投影

Type: task
Status: resolved

## Scope

通过 `projectTaskEvent` 投影权限模式、待审批集合和等待审批状态。

## Comments

## Answer

`TaskProjection` 已投影 `permissionMode`、去重的 `pendingApprovals` 与 `waiting-approval` 状态；`approval/resolved` 会移除对应审批并恢复执行状态。契约测试覆盖权限恢复、审批请求与解决。
