# 桌面应用打包与分发配置

Type: task
Status: resolved

## Scope

配置 Tauri 2 应用打包（macOS app/dmg、Windows msi/nsis），提供 `pnpm build:app` 脚本与 DSH 运行时分发规范。

## Answer

已通过 `tauri icon` 生成全套应用图标，在 `tauri.conf.json` 中激活并配置了 `bundle` 参数（包括 macOS `.app`/`.dmg`、Windows 描述与图标绑定），并在根目录与 `@joydsh/desktop` 的 `package.json` 中配置了 `pnpm build:app` 原生打包指令。
