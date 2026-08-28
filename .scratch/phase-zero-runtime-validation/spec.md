# 阶段零：运行时验证

Status: resolved
Label: ready-for-agent

## 目标

证明 JoyDSH 的独立 Tauri 界面可以在不加载 DeepSeek Harness 官方网页界面的情况下，启动固定版本运行时、创建任务会话、发送输入、接收实时会话事件、停止任务，并在运行时重启后从 DSH 持久记录恢复任务会话。

## 范围

- 固定 `@deepseek-ai/dsh@0.1.1-rc.2` 与 Tauri CLI `2.11.4`。
- 受管 DSH 仅监听 `127.0.0.1`。
- 一元命令使用 DSH `/api` RPC；会话事件和宿主事件使用两个 WebSocket 下行流。
- 界面只依赖 JoyDSH 领域类型和 `DshAdapter`，不导入 DSH 内部类型。
- 单工作空间、单前台任务会话，不实现并发、审批、差异、完整首页或发布打包。

## 验收标准

1. 用户可从 Tauri 界面启动和停止受管 DSH 进程。
2. 用户可为一个本地路径创建任务会话并发送文字目标。
3. 界面按顺序显示会话事件和宿主状态事件。
4. 用户可停止正在执行的任务。
5. DSH 重启后，界面可重新列出并回放已有任务会话。
6. 适配器契约和任务投影具有独立自动化测试。

## 已确认测试边界

- `DshAdapter` 公共接口：健康检查、创建、列出、回放、发送、停止、订阅。
- `projectTaskEvent` 公共投影函数：把 JoyDSH 任务事件归并为可渲染状态。
- 不测试 DSH 私有服务、Tauri 框架内部实现或 React 内部状态。

## 风险

- DSH 仍处于预览阶段，wire contract 可能破坏性变化；固定版本并在适配层解析未知输入。
- 阶段零通过已发布的 `web` profile 提供 API Gateway 与事件流，但 JoyDSH 不加载其网页界面；专用组合包边界留到验证 wire contract 后收敛。
- 开发模式依赖本机 `pnpm` 与 Node.js；受管 Node.js 打包不在阶段零范围。

## Answer

阶段零已完成。独立 Tauri 界面通过 Rust 代理调用固定版本 DSH，并将 mux/host 两条 WebSocket 事件流转发为 Tauri 事件；界面只消费 JoyDSH 领域类型。真实 DSH 验证覆盖会话创建、输入、停止、重启后列出会话及 18 条历史事件回放。模型生成受本机缺少 `deepseek-official` provider API key 阻塞，运行时正确产生 `host/agent-error`，不属于适配层故障。
