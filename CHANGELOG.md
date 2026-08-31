# Changelog

## Unreleased

- 优化任务会话流式生成中的滚动体验：实现智能吸底与向上回看保护（Stick-to-bottom），在模型生成与输出更新时，若用户向上滚动查看历史记录，不再强行置底打断阅读；当用户滚回底部或发送新消息/切换会话时自动恢复跟随，并在脱离底部时提供一键“回到底部”悬浮按钮。
- 优化 Markdown 代码块与行内代码解析与展示：代码块容器与内部 `<pre><code>` 默认支持自动换行（`white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere`），消除长代码行或长文本导致的横向溢出与裁剪；重构 Markdown 语法树中 `pre` / `code` 的块级解析逻辑，确保单行无语言标签的代码块也能稳定渲染为带复制操作的独立代码卡片。
- 优化顶栏工作区导航与肩键视觉效果：移除项目栏固定最大宽度限制，使其自适应横向拉长并扩展项目名称可视区域；为项目滚动容器补充内边距与聚焦安全边距，彻底修复手柄/键盘选中时外发光与轮廓被边界裁剪的问题；精简 L1 / R1 肩键徽标结构，消除嵌套双层框，并支持鼠标点击快速循环切换工作区。

- 优化系统设置界面形式与视觉基调：默认采用符合 TV 工作空间规范的深色基调（`dark`），弹窗遮罩增加现代毛玻璃虚化（`backdrop-filter: blur(14px)`）与弹性出入场动画；重构为标准弹窗结构，新增“模型服务”、“输入与外设”、“外观个性化”三类别 Tab 导航，解决原长列表堆叠截断问题，并抽取独立 `SettingsCenter` 组件且全面支持手柄/键盘焦点导航。

- 新增"外观"设置分组：支持暗色 / 亮色 / 跟随系统三选一主题，以及纯色 / CSS 渐变 / 预设图 / 自定义图片四种背景模式，并提供蒙版不透明度与背景模糊两个滑杆。所有偏好通过 Rust 新增的 `load_ui_preferences` / `save_ui_preferences` 写入 `app_local_data_dir/ui-preferences.json`，重启后自动恢复；自定义图片会复制到 `app_local_data_dir/backgrounds/` 并以 base64 data URL 形式回传，避免 WebView 加载 `file://` 出现 CORS 报错。
- 样式系统重构为 design token：3187 行 `styles.css` 抽出 30+ 语义变量（`--surface-*` / `--border-*` / `--text-*` / `--accent-*` / `--state-*` / `--state-info` / `--state-success-tint` / …），通过根节点 `[data-theme]` 切换。暗色为默认，亮色由同色相加深一档的 accent + 浅色 surface 组成，亮色状态色单独对齐到 4.5:1 以上对比度。
- 资源包里内置 5 张 SVG 预设背景（aurora / dusk / mesh / paper / forest），通过 Tauri 资源打进 `JoyDSH.app/Contents/Resources/backgrounds/`，设置面板用 `list_preset_backgrounds` 实时列出、点选即用。
- 修复桌面应用从 Finder / Launchpad 启动时 DSH 运行时无法拉起的故障：之前 `dsh` shim 通过 `exec node` 启动，但 Tauri 子进程继承的 `PATH` 是 launchd 默认值，不包含用户安装的 `node`，导致进程立刻退出、15 秒健康检查全部失败、报"运行时启动超时"。现在 Rust 端按 `JOYDSH_NODE_BIN` → Tauri 资源 → 系统 `PATH` → 常见 Homebrew/Linuxbrew 路径的顺序解析 `node`，并把它的目录注入子进程 `PATH`；同时把 stdout/stderr 接到 `<DSH_HOME>/runtime.log`，错误信息也带上日志路径，下次失败可以直接看到 `exec: node: not found` 这类真实原因。
- 新增 `pnpm setup:node` 与 `scripts/install-node.mjs`：在 `tauri build` 之前自动把 Node 22 LTS 下载并解压到 `apps/desktop/src-tauri/resources/node/<plat>-<arch>/node`，再由 `tauri.conf.json` 的 `bundle.resources` 打进 `.app/Resources/node/`，让生产构建完全自包含，不再依赖宿主机的 `node`。紧急情况下也可以直接 `export JOYDSH_NODE_BIN=/path/to/node` 临时绕开。
- 优化命令消息的展示层级，并隐藏运行时展开的 skill 内部指令，避免其混入用户对话。
- 支持一键截取当前 JoyDSH 项目页面并直接添加为待发送图片，无需进入额外的标注页面。
- 移除输入工具栏中无效且重复的“图片”文件选择按钮，保留粘贴、拖放与截图入口。
- 支持在输入框或多行文本框中使用手柄西侧键删除文字。
- 支持在任务工作区和命令中心回答 DSH 结构化问题、审阅 Markdown 实施方案，并通过键盘或手柄完成整组回应。
- 右侧任务检查器默认隐藏，并支持整体显示或隐藏；隐藏后主任务区自动占满可用空间。
- 收紧新建项目默认权限控件的外框高度，使其与内部选项紧凑对齐。
