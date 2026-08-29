import { Check, X } from 'lucide-react'

export interface GamepadSelectChoice {
  optionIndex: number
  label: string
  selected: boolean
}

export interface GamepadSelectSession {
  select: HTMLSelectElement
  focusId: string
  label: string
  choices: readonly GamepadSelectChoice[]
}

export function createGamepadSelectSession(select: HTMLSelectElement): GamepadSelectSession {
  const focusId = select.dataset.focusId ?? select.id
  const label = select.labels?.[0]?.textContent?.trim() || select.getAttribute('aria-label') || '选择选项'
  return {
    select,
    focusId,
    label,
    choices: Array.from(select.options)
      .map((option, optionIndex) => ({
        optionIndex,
        label: option.label || option.text || option.value,
        selected: optionIndex === select.selectedIndex,
        disabled: option.disabled,
      }))
      .filter(choice => !choice.disabled)
      .map(({ disabled: _disabled, ...choice }) => choice),
  }
}

export function applyGamepadSelectChoice(session: GamepadSelectSession, optionIndex: number): boolean {
  const option = session.select.options[optionIndex]
  if (option === undefined || option.disabled || optionIndex === session.select.selectedIndex) return false
  session.select.selectedIndex = optionIndex
  session.select.dispatchEvent(new Event('input', { bubbles: true }))
  session.select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

interface GamepadSelectOverlayProps {
  session: GamepadSelectSession
  onChoose(optionIndex: number): void
  onClose(): void
}

export function GamepadSelectOverlay({ session, onChoose, onClose }: GamepadSelectOverlayProps) {
  return (
    <div className="gamepad-select-overlay" role="presentation" onMouseDown={event => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <section className="gamepad-select-sheet" role="dialog" aria-modal="true" aria-labelledby="gamepad-select-title">
        <header className="gamepad-select-header">
          <div>
            <span className="step-label">选择</span>
            <h2 id="gamepad-select-title">{session.label}</h2>
          </div>
          <button
            data-focus-id="gamepad-select-close"
            className="icon-button icon-button--quiet"
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭选项"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="gamepad-select-options" data-scroll-region="gamepad-select">
          {session.choices.map(choice => (
            <button
              key={choice.optionIndex}
              data-focus-id={`gamepad-select-option-${choice.optionIndex}`}
              className={choice.selected ? 'gamepad-select-option gamepad-select-option--selected' : 'gamepad-select-option'}
              type="button"
              aria-pressed={choice.selected}
              onClick={() => onChoose(choice.optionIndex)}
            >
              <span>{choice.label}</span>
              {choice.selected ? <Check aria-hidden="true" /> : <span className="gamepad-select-option__spacer" />}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
