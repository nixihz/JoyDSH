# 结构化问题协议

Type: task
Status: resolved

## Scope

通过 `DshAdapter` 公共接口解析 DSH 问题控制事件，并提交整组结构化回答或取消请求。

## Comments

## Answer

`DshAdapter` 已校验并交付合法 `question/requested` 控制事件，通过原始 `rpcId` 提交整组结构化回答，并按 DSH 约定编码取消结果。契约测试覆盖三条公共路径。
