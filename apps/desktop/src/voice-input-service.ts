export type VoiceInputTargetKey =
  | 'right-command'
  | 'left-command'
  | 'right-option'
  | 'left-option'
  | 'right-control'
  | 'left-control'
  | 'function'
  | 'f5'
  | 'f6'
  | 'space'
  | 'custom'

export type VoiceInputMode = 'toggle' | 'push-to-talk'

export type VoiceInputGamepadButton = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 10 | 11

export interface VoiceInputConfig {
  enabled: boolean
  targetKey: VoiceInputTargetKey
  mode: VoiceInputMode
  gamepadButton: VoiceInputGamepadButton
  customKeyCode?: number
}

export type KeySimulationAction = 'tap' | 'press' | 'release'

export interface KeySimulationCapabilities {
  supported: boolean
  platform: string
  defaultTarget: string | Record<string, unknown>
}

const STORAGE_KEY = 'joydsh:voice-input-config'

export const DEFAULT_VOICE_INPUT_CONFIG: VoiceInputConfig = {
  enabled: true,
  targetKey: 'right-command',
  mode: 'toggle',
  gamepadButton: 8,
}

export const GAMEPAD_BUTTON_OPTIONS: ReadonlyArray<{ index: VoiceInputGamepadButton, label: string }> = [
  { index: 8, label: 'Select / Share / View' },
  { index: 10, label: '左摇杆按下 (L3)' },
  { index: 11, label: '右摇杆按下 (R3)' },
  { index: 6, label: '左扳机 (L2 / LT)' },
  { index: 7, label: '右扳机 (R2 / RT)' },
  { index: 4, label: '左肩键 (L1 / LB)' },
  { index: 5, label: '右肩键 (R1 / RB)' },
  { index: 0, label: '南侧键 (X / A)' },
  { index: 1, label: '东侧键 (圆圈 / B)' },
  { index: 2, label: '西侧键 (方块 / X)' },
  { index: 3, label: '北侧键 (三角 / Y)' },
]

const GAMEPAD_BUTTONS = new Set<number>(GAMEPAD_BUTTON_OPTIONS.map(option => option.index))

export const TARGET_KEY_OPTIONS: ReadonlyArray<{ key: VoiceInputTargetKey, label: string, description: string }> = [
  { key: 'right-command', label: 'Right Command (右 Cmd)', description: 'Spokenly / Superwhisper 推荐' },
  { key: 'right-option', label: 'Right Option (右 Alt)', description: '常用副修饰键' },
  { key: 'left-command', label: 'Left Command (左 Cmd)', description: '标准 Command 键' },
  { key: 'function', label: 'Fn / 地球仪键', description: 'macOS 原生听写' },
  { key: 'right-control', label: 'Right Control (右 Ctrl)', description: 'Windows 推荐' },
  { key: 'f5', label: 'F5', description: '传统快捷功能键' },
  { key: 'f6', label: 'F6', description: '听写热键备选' },
  { key: 'custom', label: '自定义键码 (Custom)', description: '指定原生虚拟按键码' },
]

export function loadVoiceInputConfig(): VoiceInputConfig {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DEFAULT_VOICE_INPUT_CONFIG
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_VOICE_INPUT_CONFIG
    const parsed = JSON.parse(raw) as Partial<VoiceInputConfig>
    const config: VoiceInputConfig = {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_VOICE_INPUT_CONFIG.enabled,
      targetKey: parsed.targetKey ?? DEFAULT_VOICE_INPUT_CONFIG.targetKey,
      mode: parsed.mode === 'push-to-talk' ? 'push-to-talk' : 'toggle',
      gamepadButton: GAMEPAD_BUTTONS.has(parsed.gamepadButton as number)
        ? parsed.gamepadButton as VoiceInputGamepadButton
        : DEFAULT_VOICE_INPUT_CONFIG.gamepadButton,
      ...(typeof parsed.customKeyCode === 'number' ? { customKeyCode: parsed.customKeyCode } : {}),
    }
    return config
  } catch {
    return DEFAULT_VOICE_INPUT_CONFIG
  }
}

export function saveVoiceInputConfig(config: VoiceInputConfig): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

export function toVirtualKeyTarget(targetKey: VoiceInputTargetKey, customKeyCode?: number): Record<string, unknown> | string {
  switch (targetKey) {
    case 'right-command': return 'rightCommand'
    case 'left-command': return 'leftCommand'
    case 'right-option': return 'rightOption'
    case 'left-option': return 'leftOption'
    case 'right-control': return 'rightControl'
    case 'left-control': return 'leftControl'
    case 'function': return 'function'
    case 'f5': return 'f5'
    case 'f6': return 'f6'
    case 'space': return 'space'
    case 'custom': return { custom: customKeyCode ?? 54 }
  }
}

export async function simulateKeyAction(
  targetKey: VoiceInputTargetKey,
  action: KeySimulationAction,
  customKeyCode?: number,
): Promise<void> {
  const target = toVirtualKeyTarget(targetKey, customKeyCode)
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('simulate_key_action', { target, action })
  } catch (error) {
    if (typeof window !== 'undefined' && !(window as any).__TAURI_INTERNALS__) {
      // Browser preview mode fallback
      return
    }
    throw error
  }
}

export async function checkKeySimulationSupport(): Promise<KeySimulationCapabilities> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<KeySimulationCapabilities>('check_key_simulation_support')
  } catch {
    return {
      supported: false,
      platform: 'browser-preview',
      defaultTarget: 'rightCommand',
    }
  }
}
