# DSH 审批回应契约

Type: task
Status: resolved
Blocked by: 01

## Scope

在 `DshAdapter` 公共接口增加权限切换和一次性审批回应。

## Comments

## Answer

`DshAdapter` 已提供 `setTaskPermission` 与 `respondToApproval`；Tauri 传输能把 `client-response` 映射到 `/api/respond`，并对失效审批和非法请求明确失败。相关契约与传输测试均已通过。
