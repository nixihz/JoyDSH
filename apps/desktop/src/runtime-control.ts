export interface ManagedRuntime {
  pid: number
  url: string
  version: string
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined
}

export async function startManagedRuntime(workspacePath: string): Promise<ManagedRuntime> {
  if (!isTauri()) throw new Error('浏览器预览不能启动本地运行时，请使用 Tauri 桌面应用')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<ManagedRuntime>('start_runtime', { workspacePath })
}

export async function stopManagedRuntime(): Promise<void> {
  if (!isTauri()) throw new Error('浏览器预览不能停止本地运行时，请使用 Tauri 桌面应用')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('stop_runtime')
}

