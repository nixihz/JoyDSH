#!/usr/bin/env node
// 下载与当前平台/架构匹配的 Node.js LTS，并把 `node` 可执行文件
// 解压到 `apps/desktop/src-tauri/resources/node/<target>/node[.exe]`，
// 让 Tauri 打包时把它打进应用资源，运行时不再依赖系统 PATH。
//
// 用法：
//   pnpm setup:node                 # 下载当前平台需要的 Node
//   JOYDSH_NODE_VERSION=22.22.0 pnpm setup:node   # 指定版本
//   node scripts/install-node.mjs --target darwin-arm64   # 强制目标

import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const RESOURCES_DIR = join(
  PROJECT_ROOT,
  'apps',
  'desktop',
  'src-tauri',
  'resources',
  'node',
)

const DEFAULT_NODE_VERSION = '22.22.0'

const PLATFORM_TARGETS = {
  'darwin-arm64': { archiveExt: 'tar.gz', binary: 'node' },
  'darwin-x64': { archiveExt: 'tar.gz', binary: 'node' },
  'linux-x64': { archiveExt: 'tar.gz', binary: 'node' },
  'linux-arm64': { archiveExt: 'tar.gz', binary: 'node' },
  'win-x64': { archiveExt: 'zip', binary: 'node.exe' },
  'win-arm64': { archiveExt: 'zip', binary: 'node.exe' },
}

function parseArgs(argv) {
  const args = { target: undefined, version: undefined, force: false }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--target' && i + 1 < argv.length) {
      args.target = argv[i + 1]
      i += 1
    } else if (arg === '--version' && i + 1 < argv.length) {
      args.version = argv[i + 1]
      i += 1
    } else if (arg === '--force') {
      args.force = true
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    }
  }
  return args
}

function detectTarget() {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  if (platform === 'win32') return arch === 'arm64' ? 'win-arm64' : 'win-x64'
  throw new Error(`不支持的平台：${platform}-${arch}；请通过 JOYDSH_NODE_BIN 指定 node 路径`)
}

function archiveName(version, target) {
  return `node-v${version}-${target}.${PLATFORM_TARGETS[target].archiveExt}`
}

async function downloadTo(url, dest) {
  console.log(`  下载 ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) {
    throw new Error(`下载失败：HTTP ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest))
}

function runShell(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} 退出码 ${code}`))
    })
  })
}

async function extractTarGz(archivePath, targetDir, binary) {
  // 先抽到临时子目录再移出来。BSD tar（macOS 默认）对 `tar -xzf ... --strip-components=N */<file>`
  // 的 glob 过滤支持不一致，稳妥起见只过滤顶层目录，再把 `bin/<binary>` 移到目标位置。
  const stagingDir = join(targetDir, '_stage')
  mkdirSync(stagingDir, { recursive: true })
  await runShell('tar', [
    '-xzf',
    archivePath,
    '-C',
    stagingDir,
    '--strip-components=1',
  ])
  const extractedBin = join(stagingDir, 'bin', binary)
  if (!existsSync(extractedBin)) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw new Error(`归档中未找到 ${binary}（预期路径 bin/${binary}）`)
  }
  const { renameSync } = await import('node:fs')
  renameSync(extractedBin, join(targetDir, binary))
  rmSync(stagingDir, { recursive: true, force: true })
}

async function extractZip(archivePath, targetDir, binary) {
  // `unzip` 在 Git for Windows / WSL 都自带；POSIX unzip 也常见。
  await runShell('unzip', ['-o', '-j', archivePath, `*/${binary}`, '-d', targetDir])
}

async function installForTarget(target, version, force) {
  const info = PLATFORM_TARGETS[target]
  if (info === undefined) {
    throw new Error(`未知目标 ${target}；可选：${Object.keys(PLATFORM_TARGETS).join(', ')}`)
  }
  const targetDir = join(RESOURCES_DIR, target)
  const targetBin = join(targetDir, info.binary)

  if (existsSync(targetBin) && !force) {
    const stat = statSync(targetBin)
    console.log(`✓ ${targetBin} 已存在 (${Math.round(stat.size / 1024 / 1024)} MB)，跳过`)
    return
  }

  mkdirSync(targetDir, { recursive: true })
  const archiveFile = join(targetDir, archiveName(version, target))
  const url = `https://nodejs.org/dist/v${version}/${archiveName(version, target)}`

  try {
    await downloadTo(url, archiveFile)
    console.log(`  解压 ${info.binary} 到 ${targetDir}`)
    if (info.archiveExt === 'tar.gz') {
      await extractTarGz(archiveFile, targetDir, info.binary)
    } else {
      await extractZip(archiveFile, targetDir, info.binary)
    }
  } finally {
    if (existsSync(archiveFile)) rmSync(archiveFile)
  }

  if (process.platform !== 'win32') {
    chmodSync(targetBin, 0o755)
  }

  const stat = statSync(targetBin)
  console.log(`✓ 已安装 ${targetBin} (${Math.round(stat.size / 1024 / 1024)} MB, Node ${version})`)
}

function printHelp() {
  console.log(`用法：node scripts/install-node.mjs [选项]

选项：
  --target <name>    强制目标（darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 / win-x64 / win-arm64）
  --version <v>      指定 Node 版本（默认 ${DEFAULT_NODE_VERSION}）
  --force            即使已存在也重新下载
  -h, --help         显示本帮助

也可以通过环境变量：
  JOYDSH_NODE_VERSION=v22.22.0    指定 Node 版本
  JOYDSH_NODE_BIN=/path/to/node   直接绕过下载
`)
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    return
  }
  const version = args.version ?? process.env.JOYDSH_NODE_VERSION ?? DEFAULT_NODE_VERSION
  const target = args.target ?? detectTarget()
  await installForTarget(target, version, args.force)
}

main().catch(error => {
  console.error(`✗ 安装失败：${error.message}`)
  process.exit(1)
})
