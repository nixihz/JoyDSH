import { isTauri } from './runtime-control.ts'

export async function isWindowFullscreen(): Promise<boolean> {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      return await getCurrentWindow().isFullscreen()
    } catch {
      return false
    }
  }
  if (typeof document !== 'undefined') {
    return Boolean(document.fullscreenElement)
  }
  return false
}

export async function setWindowFullscreen(fullscreen: boolean): Promise<boolean> {
  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const appWindow = getCurrentWindow()
      await appWindow.setFullscreen(fullscreen)
      return await appWindow.isFullscreen()
    } catch {
      return false
    }
  }
  if (typeof document !== 'undefined') {
    try {
      if (fullscreen) {
        if (!document.fullscreenElement && document.documentElement?.requestFullscreen) {
          await document.documentElement.requestFullscreen()
        }
      } else {
        if (document.fullscreenElement && document.exitFullscreen) {
          await document.exitFullscreen()
        }
      }
      return Boolean(document.fullscreenElement)
    } catch {
      return Boolean(document.fullscreenElement)
    }
  }
  return false
}

export async function toggleWindowFullscreen(): Promise<boolean> {
  const current = await isWindowFullscreen()
  return setWindowFullscreen(!current)
}

export function subscribeFullscreenChange(callback: (fullscreen: boolean) => void): () => void {
  let active = true

  const handleUpdate = () => {
    if (!active) return
    void isWindowFullscreen().then(fullscreen => {
      if (active) callback(fullscreen)
    })
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('fullscreenchange', handleUpdate)
    document.addEventListener('webkitfullscreenchange', handleUpdate)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleUpdate)
  }

  let unlistenTauri: (() => void) | undefined
  if (isTauri()) {
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const appWindow = getCurrentWindow()
        const unlisten = await appWindow.onResized(() => handleUpdate())
        if (active) {
          unlistenTauri = unlisten
        } else {
          unlisten()
        }
      } catch {
        // Fallback to window resize
      }
    })()
  }

  handleUpdate()

  return () => {
    active = false
    if (typeof document !== 'undefined') {
      document.removeEventListener('fullscreenchange', handleUpdate)
      document.removeEventListener('webkitfullscreenchange', handleUpdate)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', handleUpdate)
    }
    unlistenTauri?.()
  }
}
