# DSH 适配契约

Type: task
Status: resolved
Blocked by: 01

以测试先行实现一元 RPC、双事件流和重连回放的稳定 JoyDSH 接口。

## Comments

## Answer

已实现健康检查、创建、列出、回放、发送、停止和订阅接口；mux/host 事件解析为 JoyDSH 领域事件，并通过事件 ID 去重。适配器和任务投影共 6 个自动化测试通过。
