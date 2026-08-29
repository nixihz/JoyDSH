# 当前页面截图与剪贴板复制会话粘贴

Type: task
Status: resolved

## Scope

- 增加 `screenshot` 语义动作支持（键盘 `PrintScreen`、`F7`、`Cmd+Shift+S`、`Cmd+Shift+X` 与手柄映射）。
- 捕获当前 JoyDSH 项目窗口的整体可见页面，不包含桌面上的其他窗口。
- 剪贴板复制与会话流打通：
  - 截图后直接将图片写入系统剪贴板（`navigator.clipboard.write`），不打开额外标注页面。
  - 自动将截图添加到输入框待发送附件栏（`pendingImages`）并聚焦输入框。
  - 工具栏提供“截图”与“粘贴”按钮，无缝融入 managed focus graph。
