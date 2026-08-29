import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_VOICE_INPUT_CONFIG,
  gamepadButtonConflict,
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
    expect(config.gamepadButton).toBe(11)
    expect(config.enabled).toBe(true)
  })

  it('保存并持久化语音输入配置', () => {
    const updated: VoiceInputConfig = {
      enabled: true,
      targetKey: 'right-option',
      gamepadButton: 8,
      customKeyCode: 61,
    }
    saveVoiceInputConfig(updated)
    expect(loadVoiceInputConfig()).toEqual(updated)
    expect(JSON.parse(storage['joydsh:voice-input-config'] ?? '{}')).toEqual({ version: 2, ...updated })
  })

  it('迁移旧模式配置并补充新的默认 R3 映射', () => {
    storage['joydsh:voice-input-config'] = JSON.stringify({
      enabled: true,
      targetKey: 'function',
      mode: 'toggle',
    })

    expect(loadVoiceInputConfig()).toEqual({
      enabled: true,
      targetKey: 'function',
      gamepadButton: 11,
    })
  })

  it('保留已经明确保存的旧手柄映射', () => {
    storage['joydsh:voice-input-config'] = JSON.stringify({
      enabled: true,
      targetKey: 'right-command',
      mode: 'push-to-talk',
      gamepadButton: 8,
    })

    expect(loadVoiceInputConfig()).toEqual({
      enabled: true,
      targetKey: 'right-command',
      gamepadButton: 8,
    })
  })

  it('说明语音映射会替代已有的手柄动作', () => {
    expect(gamepadButtonConflict(4)).toBe('上一个项目')
    expect(gamepadButtonConflict(0)).toBe('确认')
    expect(gamepadButtonConflict(8)).toBeUndefined()
    expect(gamepadButtonConflict(11)).toBeUndefined()
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
