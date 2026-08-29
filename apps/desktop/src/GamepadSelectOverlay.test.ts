import { describe, expect, it } from 'vitest'
import { applyGamepadSelectChoice, createGamepadSelectSession } from './GamepadSelectOverlay.tsx'

describe('手柄下拉选择层', () => {
  it('读取可用选项、保留当前项并应用选择', () => {
    const dispatched: string[] = []
    const select = {
      dataset: { focusId: 'voice-input-key' },
      id: 'voice-input-key',
      labels: [{ textContent: '听写软件触发键' }],
      getAttribute: () => null,
      selectedIndex: 0,
      options: [
        { label: 'Right Command', text: 'Right Command', value: 'right-command', disabled: false },
        { label: '不可用', text: '不可用', value: 'disabled', disabled: true },
        { label: 'Right Option', text: 'Right Option', value: 'right-option', disabled: false },
      ],
      dispatchEvent: (event: Event) => {
        dispatched.push(event.type)
        return true
      },
    } as unknown as HTMLSelectElement

    const session = createGamepadSelectSession(select)
    expect(session.focusId).toBe('voice-input-key')
    expect(session.label).toBe('听写软件触发键')
    expect(session.choices).toEqual([
      { optionIndex: 0, label: 'Right Command', selected: true },
      { optionIndex: 2, label: 'Right Option', selected: false },
    ])

    expect(applyGamepadSelectChoice(session, 2)).toBe(true)
    expect(select.selectedIndex).toBe(2)
    expect(dispatched).toEqual(['input', 'change'])
  })
})
