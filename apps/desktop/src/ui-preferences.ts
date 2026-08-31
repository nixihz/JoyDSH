// 主题 + 自定义背景的偏好管理。
//
// 数据结构：
//   ThemeMode: 'dark' | 'light' | 'auto'
//   Background: { kind: 'none' } | { kind: 'color' | 'gradient' | 'image'; value: string;
//                                 blur: number; opacity: number }
//
// 持久化路径：Rust 端把整个 UiPreferences JSON 写入
// app_local_data_dir/ui-preferences.json。读写都是同步的
// （对单用户本地偏好来说延迟可以忽略），出错时回退到默认。

import { useCallback, useEffect, useState } from 'react'
import { isTauri } from './runtime-control.ts'

export type ThemeMode = 'dark' | 'light' | 'auto'
export type BackgroundKind = 'none' | 'color' | 'gradient' | 'image'

export interface BackgroundConfig {
  kind: BackgroundKind
  value: string
  blur: number
  opacity: number
}

export interface UiPreferences {
  theme: ThemeMode
  background: BackgroundConfig
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  theme: 'dark',
  background: {
    kind: 'none',
    value: '',
    blur: 0,
    opacity: 0.85,
  },
}

const MIN_BLUR = 0
const MAX_BLUR = 24
const MIN_OPACITY = 0
const MAX_OPACITY = 1

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.max(min, Math.min(max, value))
}

export function normalizeUiPreferences(input: unknown): UiPreferences {
  if (typeof input !== 'object' || input === null) return DEFAULT_UI_PREFERENCES
  const raw = input as Record<string, unknown>
  const theme = raw.theme
  const bg = raw.background
  const themeMode: ThemeMode = theme === 'dark' || theme === 'light' || theme === 'auto'
    ? theme
    : 'dark'
  let background: BackgroundConfig
  if (typeof bg === 'object' && bg !== null) {
    const b = bg as Record<string, unknown>
    const kind = b.kind
    const value = typeof b.value === 'string' ? b.value : ''
    const blur = typeof b.blur === 'number' ? clamp(b.blur, MIN_BLUR, MAX_BLUR) : 0
    const opacity = typeof b.opacity === 'number' ? clamp(b.opacity, MIN_OPACITY, MAX_OPACITY) : 0.85
    if (kind === 'color' || kind === 'gradient' || kind === 'image' || kind === 'none') {
      background = { kind, value, blur, opacity }
    } else {
      background = DEFAULT_UI_PREFERENCES.background
    }
  } else {
    background = DEFAULT_UI_PREFERENCES.background
  }
  return { theme: themeMode, background }
}

async function load(): Promise<UiPreferences> {
  if (!isTauri()) return DEFAULT_UI_PREFERENCES
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const raw = await invoke<unknown>('load_ui_preferences')
    return normalizeUiPreferences(raw)
  } catch {
    return DEFAULT_UI_PREFERENCES
  }
}

async function persist(prefs: UiPreferences): Promise<void> {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('save_ui_preferences', { preferences: prefs })
  } catch {
    // 持久化失败不阻塞 UI；下次打开时仍会用默认值兜底
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolveEffectiveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'auto') return systemPrefersDark() ? 'dark' : 'light'
  return mode
}

export function applyDocumentAttributes(effective: 'dark' | 'light', background: BackgroundConfig): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute('data-theme', effective)
  root.setAttribute('data-bg-kind', background.kind)
  // image: data URL 需要 url("…") 包裹才能进 background-image；
  // gradient: 已经是合法的 background-image 值（linear-gradient(...)），直接传；
  // color: 走 background-color 分支；none: 清空
  let userBackground: string
  if (background.kind === 'image') {
    userBackground = background.value ? `url("${background.value}")` : 'none'
  } else if (background.kind === 'gradient') {
    userBackground = background.value || 'none'
  } else {
    userBackground = 'none'
  }
  root.style.setProperty('--user-background', userBackground)
  // 纯色单独走 background-color 变量，避免和 image 互串
  root.style.setProperty('--user-color', background.kind === 'color' ? background.value : 'transparent')
  root.style.setProperty('--background-blur', `${background.blur}px`)
  // 在背景层之上覆盖一层蒙版，opacity 决定可见度
  root.style.setProperty('--background-overlay',
    effective === 'dark'
      ? `rgba(11, 14, 16, ${(1 - background.opacity).toFixed(3)})`
      : `rgba(245, 247, 249, ${(1 - background.opacity).toFixed(3)})`,
  )
}

export interface UseUiPreferencesResult {
  preferences: UiPreferences
  setTheme: (theme: ThemeMode) => void
  setBackground: (updater: (current: BackgroundConfig) => BackgroundConfig) => void
  resetBackground: () => void
  isLoaded: boolean
}

export function useUiPreferences(): UseUiPreferencesResult {
  const [preferences, setPreferences] = useState<UiPreferences>(DEFAULT_UI_PREFERENCES)
  const [isLoaded, setIsLoaded] = useState(false)
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark())

  useEffect(() => {
    let cancelled = false
    void load().then(prefs => {
      if (cancelled) return
      setPreferences(prefs)
      setIsLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  // 监听系统色板变化，仅在 'auto' 模式下生效
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', handler)
    return () => media.removeEventListener('change', handler)
  }, [])

  // 把当前偏好应用到 document
  useEffect(() => {
    const effective = resolveEffectiveTheme(preferences.theme)
    const effectiveTheme = preferences.theme === 'auto' ? (systemDark ? 'dark' : 'light') : preferences.theme
    void effectiveTheme
    applyDocumentAttributes(effective, preferences.background)
  }, [preferences, systemDark])

  const setTheme = useCallback((theme: ThemeMode) => {
    setPreferences(current => {
      const next = { ...current, theme }
      void persist(next)
      return next
    })
  }, [])

  const setBackground = useCallback((updater: (current: BackgroundConfig) => BackgroundConfig) => {
    setPreferences(current => {
      const next = { ...current, background: updater(current.background) }
      void persist(next)
      return next
    })
  }, [])

  const resetBackground = useCallback(() => {
    setPreferences(current => {
      const next = { ...current, background: DEFAULT_UI_PREFERENCES.background }
      void persist(next)
      return next
    })
  }, [])

  return { preferences, setTheme, setBackground, resetBackground, isLoaded }
}

export const UI_PREFERENCE_LIMITS = {
  minBlur: MIN_BLUR,
  maxBlur: MAX_BLUR,
  minOpacity: MIN_OPACITY,
  maxOpacity: MAX_OPACITY,
}

export interface PresetBackground {
  id: string
  label: string
  dataUrl: string
  mime: string
  bytes: number
}
