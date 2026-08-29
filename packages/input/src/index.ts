export type SemanticAction =
  | 'move-up'
  | 'move-down'
  | 'move-left'
  | 'move-right'
  | 'confirm'
  | 'back'
  | 'primary-action'
  | 'more-actions'
  | 'previous-region'
  | 'next-region'
  | 'previous-page'
  | 'next-page'
  | 'previous-project'
  | 'next-project'
  | 'previous-session'
  | 'next-session'
  | 'new-session'
  | 'new-project'
  | 'scroll-up'
  | 'scroll-down'
  | 'scroll-left'
  | 'scroll-right'
  | 'command-center'
  | 'pause-task'
  | 'voice-input'
  | 'voice-input-release'
  | 'screenshot'

export interface KeyboardInput {
  key: string
  textEntry: boolean
  multiline?: boolean
  isAtStart?: boolean
  isAtEnd?: boolean
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

export function mapKeyboardAction(input: KeyboardInput): SemanticAction | undefined {
  if (input.key === 'PrintScreen' || input.key === 'F7') {
    return 'screenshot'
  }
  if ((input.key.toLowerCase() === 's' || input.key.toLowerCase() === 'x') && (input.metaKey === true || input.ctrlKey === true) && input.shiftKey === true) {
    return 'screenshot'
  }
  if (input.key.toLowerCase() === 'k' && (input.metaKey === true || input.ctrlKey === true)) {
    return 'command-center'
  }
  if (input.key.toLowerCase() === 'v' && (input.metaKey === true || input.ctrlKey === true) && input.shiftKey === true) {
    return 'voice-input'
  }
  if (input.key === 'F5' || input.key === 'F6') {
    return 'voice-input'
  }
  if (input.key.toLowerCase() === 'n' && (input.metaKey === true || input.ctrlKey === true)) {
    return input.shiftKey === true ? 'new-project' : 'new-session'
  }
  if (input.key === 'Escape') return 'back'
  if (input.key === 'Tab') return input.shiftKey === true ? 'previous-region' : 'next-region'
  if (input.textEntry) {
    if (input.multiline === false) {
      if (input.key === 'ArrowUp') return 'move-up'
      if (input.key === 'ArrowDown') return 'move-down'
    } else if (input.multiline === true) {
      if (input.key === 'ArrowUp' && input.isAtStart === true) return 'move-up'
      if (input.key === 'ArrowDown' && input.isAtEnd === true) return 'move-down'
    }
    return undefined
  }
  if (input.key === '[' || input.key === '{') return 'previous-project'
  if (input.key === ']' || input.key === '}') return 'next-project'
  if (input.key === 'ArrowUp') return 'move-up'
  if (input.key === 'ArrowDown') return 'move-down'
  if (input.key === 'ArrowLeft') return 'move-left'
  if (input.key === 'ArrowRight') return 'move-right'
  if (input.key === 'PageUp') return 'previous-page'
  if (input.key === 'PageDown') return 'next-page'
  if (input.key === 'Enter' || input.key === ' ') return 'confirm'
  if (input.key.toLowerCase() === 'a') return 'primary-action'
  if (input.key.toLowerCase() === 'r') return 'more-actions'
  return undefined
}

export interface GamepadSnapshot {
  buttons: readonly boolean[]
  axes: readonly number[]
}

export interface GamepadMapper {
  update(snapshot: GamepadSnapshot, now: number): SemanticAction[]
  reset(): SemanticAction[]
}

export interface GamepadMapperOptions {
  axisThreshold?: number
  initialRepeatDelayMs?: number
  repeatIntervalMs?: number
  menuLongPressMs?: number
  voiceInputButtonIndex?: number
  screenshotButtonIndex?: number
}

const REPEATABLE_ACTIONS = new Set<SemanticAction>([
  'move-up', 'move-down', 'move-left', 'move-right',
  'scroll-up', 'scroll-down', 'scroll-left', 'scroll-right',
])

const BUTTON_ACTIONS: ReadonlyArray<readonly [number, SemanticAction]> = [
  [0, 'confirm'],
  [1, 'back'],
  [2, 'primary-action'],
  [3, 'more-actions'],
  [4, 'previous-project'],
  [5, 'next-project'],
  [6, 'previous-page'],
  [7, 'next-page'],
  [12, 'move-up'],
  [13, 'move-down'],
  [14, 'move-left'],
  [15, 'move-right'],
]

export function createGamepadMapper(options: GamepadMapperOptions = {}): GamepadMapper {
  const threshold = options.axisThreshold ?? 0.65
  const initialDelay = options.initialRepeatDelayMs ?? 320
  const repeatInterval = options.repeatIntervalMs ?? 120
  const menuLongPressMs = options.menuLongPressMs ?? 700
  const voiceInputButtonIndex = options.voiceInputButtonIndex ?? 11
  const screenshotButtonIndex = options.screenshotButtonIndex
  const held = new Map<SemanticAction, { pressedAt: number, lastEmittedAt: number }>()
  let menuPressedAt: number | undefined
  let menuLongPressEmitted = false

  return {
    update(snapshot, now) {
      const active = activeGamepadActions(snapshot, threshold, voiceInputButtonIndex, screenshotButtonIndex)
      const emitted: SemanticAction[] = []
      const menuPressed = snapshot.buttons[9] === true

      if (menuPressed) {
        if (menuPressedAt === undefined) {
          menuPressedAt = now
          menuLongPressEmitted = false
        } else if (!menuLongPressEmitted && now - menuPressedAt >= menuLongPressMs) {
          menuLongPressEmitted = true
          emitted.push('pause-task')
        }
      } else if (menuPressedAt !== undefined) {
        if (!menuLongPressEmitted) {
          emitted.push(now - menuPressedAt >= menuLongPressMs ? 'pause-task' : 'command-center')
        }
        menuPressedAt = undefined
        menuLongPressEmitted = false
      }

      for (const action of active) {
        const state = held.get(action)
        if (state === undefined) {
          held.set(action, { pressedAt: now, lastEmittedAt: now })
          emitted.push(action)
          continue
        }
        if (!REPEATABLE_ACTIONS.has(action)) continue
        if (now - state.pressedAt < initialDelay || now - state.lastEmittedAt < repeatInterval) continue
        state.lastEmittedAt = now
        emitted.push(action)
      }

      for (const action of held.keys()) {
        if (!active.includes(action)) {
          if (action === 'voice-input') {
            emitted.push('voice-input-release')
          }
          held.delete(action)
        }
      }
      return emitted
    },
    reset() {
      const emitted: SemanticAction[] = held.has('voice-input') ? ['voice-input-release'] : []
      held.clear()
      menuPressedAt = undefined
      menuLongPressEmitted = false
      return emitted
    },
  }
}

function activeGamepadActions(
  snapshot: GamepadSnapshot,
  threshold: number,
  voiceInputButtonIndex: number,
  screenshotButtonIndex?: number,
): SemanticAction[] {
  const actions: SemanticAction[] = []
  for (const [index, action] of BUTTON_ACTIONS) {
    if (index === voiceInputButtonIndex || index === screenshotButtonIndex) continue
    if (snapshot.buttons[index] === true && !actions.includes(action)) actions.push(action)
  }
  if (snapshot.buttons[voiceInputButtonIndex] === true) actions.push('voice-input')
  if (screenshotButtonIndex !== undefined && snapshot.buttons[screenshotButtonIndex] === true) {
    actions.push('screenshot')
  }
  const horizontal = snapshot.axes[0] ?? 0
  const vertical = snapshot.axes[1] ?? 0
  const scrollHorizontal = snapshot.axes[2] ?? 0
  const scrollVertical = snapshot.axes[3] ?? 0
  if (vertical <= -threshold && !actions.includes('move-up')) actions.push('move-up')
  if (vertical >= threshold && !actions.includes('move-down')) actions.push('move-down')
  if (horizontal <= -threshold && !actions.includes('move-left')) actions.push('move-left')
  if (horizontal >= threshold && !actions.includes('move-right')) actions.push('move-right')
  if (scrollVertical <= -threshold) actions.push('scroll-up')
  if (scrollVertical >= threshold) actions.push('scroll-down')
  if (scrollHorizontal <= -threshold) actions.push('scroll-left')
  if (scrollHorizontal >= threshold) actions.push('scroll-right')
  return actions
}
