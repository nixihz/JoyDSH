# 安全拒绝与任务回滚

Type: task
Status: resolved
Blocked by: 02

## Scope

接入逐文件拒绝和任务级回滚；在任何文件写入前验证任务、工作区、HEAD、Git 操作状态和完整期望快照，并返回最新快照。

## Answer

已在 Rust 端实现原子文件隔离与两阶段回滚事务，支持单文件拒绝与任务级全量安全回滚；严禁使用 `git clean`/`git reset --hard`，全过程校验任务基线、HEAD、index 锁与工作区指纹，并在异常与中断时通过 durable journal 安全恢复。
