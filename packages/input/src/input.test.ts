import { describe, expect, it } from 'vitest'
import { createGamepadMapper, mapKeyboardAction } from './index.ts'

describe('语义输入', () => {
  it('键盘导航与文字输入共享语义而不争抢方向键', () => {
    expect(mapKeyboardAction({ key: 'ArrowUp', textEntry: false })).toBe('move-up')
    expect(mapKeyboardAction({ key: 'Enter', textEntry: false })).toBe('confirm')
    expect(mapKeyboardAction({ key: 'Tab', textEntry: true })).toBe('next-region')
    expect(mapKeyboardAction({ key: 'Tab', shiftKey: true, textEntry: true })).toBe('previous-region')
    expect(mapKeyboardAction({ key: 'PageUp', textEntry: false })).toBe('previous-page')
    expect(mapKeyboardAction({ key: 'PageDown', textEntry: false })).toBe('next-page')
    expect(mapKeyboardAction({ key: 'ArrowUp', textEntry: true, multiline: false })).toBe('move-up')
    expect(mapKeyboardAction({ key: 'ArrowDown', textEntry: true, multiline: false })).toBe('move-down')
    expect(mapKeyboardAction({ key: 'ArrowLeft', textEntry: true, multiline: false })).toBeUndefined()
    expect(mapKeyboardAction({ key: 'ArrowUp', textEntry: true, multiline: true, isAtStart: false })).toBeUndefined()
    expect(mapKeyboardAction({ key: 'ArrowUp', textEntry: true, multiline: true, isAtStart: true })).toBe('move-up')
    expect(mapKeyboardAction({ key: 'ArrowDown', textEntry: true, multiline: true, isAtEnd: true })).toBe('move-down')
    expect(mapKeyboardAction({ key: 'PageDown', textEntry: true })).toBeUndefined()
    expect(mapKeyboardAction({ key: 'Enter', textEntry: true })).toBeUndefined()
  })

  it('将 Cmd/Ctrl+K 视为全局命令中心动作', () => {
    expect(mapKeyboardAction({ key: 'k', metaKey: true, textEntry: false })).toBe('command-center')
    expect(mapKeyboardAction({ key: 'K', ctrlKey: true, textEntry: true })).toBe('command-center')
    expect(mapKeyboardAction({ key: 'k', textEntry: false })).toBeUndefined()
  })

  it('标准 Gamepad 在按下边沿触发动作并受控重复方向', () => {
    const mapper = createGamepadMapper({ initialRepeatDelayMs: 300, repeatIntervalMs: 100 })
    const idle = { buttons: Array.from({ length: 16 }, () => false), axes: [0, 0] }
    const confirmAndDown = {
      buttons: idle.buttons.map((_, index) => index === 0 || index === 13),
      axes: [0, 0],
    }

    expect(mapper.update(idle, 0)).toEqual([])
    expect(mapper.update(confirmAndDown, 10)).toEqual(['confirm', 'move-down'])
    expect(mapper.update(confirmAndDown, 200)).toEqual([])
    expect(mapper.update(confirmAndDown, 310)).toEqual(['move-down'])
    expect(mapper.update(confirmAndDown, 410)).toEqual(['move-down'])
    expect(mapper.update(idle, 420)).toEqual([])
    expect(mapper.update({ ...idle, axes: [-0.8, 0] }, 430)).toEqual(['move-left'])
  })

  it('菜单键短按只在释放时打开命令中心', () => {
    const mapper = createGamepadMapper({ menuLongPressMs: 600 })
    const idle = { buttons: Array.from({ length: 16 }, () => false), axes: [0, 0, 0, 0] }
    const menuPressed = {
      ...idle,
      buttons: idle.buttons.map((_, index) => index === 9),
    }

    expect(mapper.update(menuPressed, 10)).toEqual([])
    expect(mapper.update(menuPressed, 500)).toEqual([])
    expect(mapper.update(idle, 510)).toEqual(['command-center'])
    expect(mapper.update(idle, 520)).toEqual([])
  })

  it('菜单键长按达到阈值只触发一次立即暂停', () => {
    const mapper = createGamepadMapper({ menuLongPressMs: 600 })
    const idle = { buttons: Array.from({ length: 16 }, () => false), axes: [0, 0, 0, 0] }
    const menuPressed = {
      ...idle,
      buttons: idle.buttons.map((_, index) => index === 9),
    }

    expect(mapper.update(menuPressed, 10)).toEqual([])
    expect(mapper.update(menuPressed, 609)).toEqual([])
    expect(mapper.update(menuPressed, 610)).toEqual(['pause-task'])
    expect(mapper.update(menuPressed, 900)).toEqual([])
    expect(mapper.update(idle, 910)).toEqual([])
  })

  it('右摇杆垂直轴映射内容滚动并受控重复', () => {
    const mapper = createGamepadMapper({ initialRepeatDelayMs: 300, repeatIntervalMs: 100 })
    const idle = { buttons: Array.from({ length: 16 }, () => false), axes: [0, 0, 0, 0] }
    const scrollDown = { ...idle, axes: [0, 0, 0, 0.8] }

    expect(mapper.update(scrollDown, 10)).toEqual(['scroll-down'])
    expect(mapper.update(scrollDown, 200)).toEqual([])
    expect(mapper.update(scrollDown, 310)).toEqual(['scroll-down'])
    expect(mapper.update(scrollDown, 350)).toEqual([])
    expect(mapper.update(scrollDown, 410)).toEqual(['scroll-down'])
    expect(mapper.update(idle, 420)).toEqual([])
    expect(mapper.update({ ...idle, axes: [0, 0, 0, -0.8] }, 430)).toEqual(['scroll-up'])
  })

  it('支持语音输入快捷键与手柄 Back/Select 按键映射', () => {
    expect(mapKeyboardAction({ key: 'v', metaKey: true, shiftKey: true, textEntry: false })).toBe('voice-input')
    expect(mapKeyboardAction({ key: 'V', ctrlKey: true, shiftKey: true, textEntry: true })).toBe('voice-input')
    expect(mapKeyboardAction({ key: 'F5', textEntry: false })).toBe('voice-input')
    expect(mapKeyboardAction({ key: 'F5', textEntry: true })).toBe('voice-input')

    const mapper = createGamepadMapper()
    const idle = { buttons: Array.from({ length: 16 }, () => false), axes: [0, 0, 0, 0] }
    const voicePressed = {
      ...idle,
      buttons: idle.buttons.map((_, index) => index === 8),
    }

    expect(mapper.update(voicePressed, 10)).toEqual(['voice-input'])
    expect(mapper.update(voicePressed, 100)).toEqual([])
    expect(mapper.update(idle, 150)).toEqual(['voice-input-release'])
    expect(mapper.update(idle, 200)).toEqual([])
  })

  it('支持项目与会话切换及新建快捷键与手柄肩键映射', () => {
    expect(mapKeyboardAction({ key: '[', textEntry: false })).toBe('previous-project')
    expect(mapKeyboardAction({ key: ']', textEntry: false })).toBe('next-project')
    expect(mapKeyboardAction({ key: '[', textEntry: true })).toBeUndefined()
    expect(mapKeyboardAction({ key: 'n', metaKey: true, textEntry: false })).toBe('new-session')
    expect(mapKeyboardAction({ key: 'N', ctrlKey: true, shiftKey: true, textEntry: false })).toBe('new-project')

    const mapper = createGamepadMapper()
    const idle = { buttons: Array.from({ length: 16 }, () => false), axes: [0, 0, 0, 0] }
    const l1r1Pressed = {
      ...idle,
      buttons: idle.buttons.map((_, index) => index === 4 || index === 5),
    }

    expect(mapper.update(l1r1Pressed, 10)).toEqual(['previous-project', 'next-project'])
  })
})

