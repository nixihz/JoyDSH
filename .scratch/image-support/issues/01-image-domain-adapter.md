# 领域模型与 DSH 适配器支持多模态图片

Type: task
Status: resolved

## Scope

- 在 `@joydsh/domain` 中增加 `ImageMediaType`、`ImageAttachmentInput`、`ImageAttachmentRef`、`MessageImageItem`。
- 在 `TaskProjectionMessage` 中增加 `images` 字段。
- 在 `@joydsh/dsh-adapter` 中支持 `sendInput` 组装图片内容块，并实现 `getAttachment` 调用 `session.attachment`。
- 在 `@joydsh/task-projection` 中解析事件并提取图片数据。
- 补充单元测试。

## Comments

实现规格见 `../spec.md`。
