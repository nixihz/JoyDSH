# 持久评审与快照并发保护

Type: task
Status: resolved

## Scope

由 Rust 生成密码学强度足够的 `changeId` 与 `snapshotToken`，持久化逐文件接受状态，并用单调 generation 保证崩溃恢复不会复活旧评审状态。

## Answer

已在 Rust 端实现密码学强度 `changeId` 与 `snapshotToken`（绑定任务标识与密钥），通过持久化 `TaskArtifactStore` 与单调 generation 维护逐文件接受状态；任何未决恢复 journal 会在快照生成与检查前安全恢复，崩溃恢复与重启测试均已全量通过。
