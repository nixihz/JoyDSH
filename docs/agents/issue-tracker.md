# 问题跟踪器：本地 Markdown

本仓库的问题和规格以 Markdown 文件保存在 `.scratch/`。

## 约定

- 每个功能使用一个目录：`.scratch/<功能标识>/`
- 规格文件：`.scratch/<功能标识>/spec.md`
- 实施任务：`.scratch/<功能标识>/issues/<序号>-<任务标识>.md`
- 序号从 `01` 开始，每个任务使用独立文件
- 分诊状态记录在任务文件顶部附近的 `Status:` 字段
- 评论和讨论追加在文件底部的 `## Comments` 小节

## 发布到问题跟踪器

在 `.scratch/<功能标识>/` 下创建对应文件；目录不存在时一并创建。

## 获取相关任务

读取用户提供的文件路径或任务编号对应的 Markdown 文件。

## 路径探索约定

- 路线图：`.scratch/<工作项>/map.md`
- 子任务：`.scratch/<工作项>/issues/<序号>-<任务标识>.md`
- 子任务类型使用 `Type:`，取值为 `research`、`prototype`、`grilling` 或 `task`
- 状态使用 `Status:`，取值为 `claimed` 或 `resolved`
- 依赖使用 `Blocked by: <序号>, <序号>`
- 领取任务前先将状态改为 `claimed`
- 完成后追加 `## Answer`，将状态改为 `resolved`，并在路线图中记录上下文链接

