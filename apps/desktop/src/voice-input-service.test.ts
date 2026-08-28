import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_VOICE_INPUT_CONFIG,
  loadVoiceInputConfig,
  saveVoiceInputConfig,
  toVirtualKeyTarget,
  type VoiceInputConfig,
} from './voice-input-service.ts'

describe('voice-input-service', () => {
  const originalWindow = globalThis.window
  let storage: Record<string, string> = {}

  beforeEach(() => {
    vi.restoreAllMocks()
    storage = {}

    const mockStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => { storage[key] = value },
      removeItem: (key: string) => { delete storage[key] },
      clear: () => { storage = {} },
    }

    const mockWin = {
      localStorage: mockStorage,
    }

    // @ts-expect-error mock window
    globalThis.window = mockWin
  })

  afterEach(() => {
    globalThis.window = originalWindow
  })

  it('返回默认语音输入配置', () => {
    const config = loadVoiceInputConfig()
    expect(config).toEqual(DEFAULT_VOICE_INPUT_CONFIG)
    expect(config.targetKey).toBe('right-command')
    expect(config.mode).toBe('toggle')
    expect(config.enabled).toBe(true)
  })

  it('保存并持久化语音输入配置', () => {
    const updated: VoiceInputConfig = {
      enabled: true,
      targetKey: 'right-option',
      mode: 'push-to-talk',
      customKeyCode: 61,
    }
    saveVoiceInputConfig(updated)
    expect(loadVoiceInputConfig()).toEqual(updated)
  })

  it('正确映射虚拟按键目标格式', () => {
    expect(toVirtualKeyTarget('right-command')).toBe('rightCommand')
    expect(toVirtualKeyTarget('left-command')).toBe('leftCommand')
    expect(toVirtualKeyTarget('right-option')).toBe('rightOption')
    expect(toVirtualKeyTarget('function')).toBe('function')
    expect(toVirtualKeyTarget('f5')).toBe('f5')
    expect(toVirtualKeyTarget('custom', 100)).toEqual({ custom: 100 })
    expect(toVirtualKeyTarget('custom')).toEqual({ custom: 54 })
  })
})
