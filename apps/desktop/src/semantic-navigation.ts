import { useEffect, useRef } from 'react'
import { moveFocus, restoreFocus, type FocusGraph, type FocusMove } from '@joydsh/focus'
import { createGamepadMapper, mapKeyboardAction, type SemanticAction } from '@joydsh/input'

export interface SemanticNavigationOptions {
  graph: FocusGraph
  onBack?(): void
  onCommandCenter?(): void
  onPauseTask?(): void
  onPrimaryAction?(): void
  onMoreActions?(): void
  onPreviousPage?(): void
  onNextPage?(): void
  onPreviousProject?(): void
  onNextProject?(): void
  onPreviousSession?(): void
  onNextSession?(): void
  onNewSession?(): void
  onNewProject?(): void
  onVoiceInput?(action: 'tap' | 'press' | 'release'): void
  voiceInputGamepadButton?: number
}

const SCROLL_STEP_PX = 240

const ACTION_MOVES: Partial<Record<SemanticAction, FocusMove>> = {
  'move-up': 'up',
  'move-down': 'down',
  'move-left': 'left',
  'move-right': 'right',
  'previous-region': 'previous-region',
  'next-region': 'next-region',
}

export function useSemanticNavigation(options: SemanticNavigationOptions): void {
  const optionsRef = useRef(options)
  const previousGraphRef = useRef(options.graph)
  const lastNonTextFocusRef = useRef<string | undefined>(undefined)
  optionsRef.current = options

  useEffect(() => {
    const graph = optionsRef.current.graph
    const currentId = managedFocusId(document.activeElement)
    if (currentId !== undefined && graph.nodes.some(node => node.id === currentId)) {
      previousGraphRef.current = graph
      return
    }
    const targetId = restoreFocus(previousGraphRef.current, graph, currentId)
    previousGraphRef.current = graph
    const frame = requestAnimationFrame(() => focusManagedElement(targetId))
    return () => cancelAnimationFrame(frame)
  }, [options.graph])

  useEffect(() => {
    const resolveActiveElement = (graph: FocusGraph): HTMLElement | null => {
      let active = document.activeElement
      let id = managedFocusId(active)
      if (id !== undefined && graph.nodes.some(node => node.id === id)) {
        return active instanceof HTMLElement ? active : null
      }
      const candidateId = (lastNonTextFocusRef.current !== undefined && graph.nodes.some(node => node.id === lastNonTextFocusRef.current))
        ? lastNonTextFocusRef.current
        : graph.entryId
      focusManagedElement(candidateId)
      active = document.activeElement
      return active instanceof HTMLElement ? active : null
    }

    const handleAction = (action: SemanticAction, source: 'gamepad' | 'keyboard' = 'keyboard'): void => {
      const {
        graph,
        onBack,
        onCommandCenter,
        onPauseTask,
        onPrimaryAction,
        onMoreActions,
        onPreviousPage,
        onNextPage,
      } = optionsRef.current
      const active = resolveActiveElement(graph)
      const textEntry = isTextEntry(active)
      const move = ACTION_MOVES[action]
      if (move !== undefined) {
        if (source === 'keyboard' && textEntry) {
          const isRegion = action === 'previous-region' || action === 'next-region'
          const isVertical = action === 'move-up' || action === 'move-down'
          const isSingleLine = active instanceof HTMLInputElement || active instanceof HTMLSelectElement
          const isTextareaBoundary = active instanceof HTMLTextAreaElement && (
            (action === 'move-up' && active.selectionStart === 0 && active.selectionEnd === 0) ||
            (action === 'move-down' && active.selectionStart === active.value.length && active.selectionEnd === active.value.length)
          )
          if (!isRegion && !(isSingleLine && isVertical) && !isTextareaBoundary) {
            return
          }
        }
        const targetId = moveFocus(graph, managedFocusId(active), move)
        focusManagedElement(targetId)
        if (document.activeElement instanceof HTMLElement && !isTextEntry(document.activeElement)) {
          const newId = managedFocusId(document.activeElement)
          if (newId !== undefined) lastNonTextFocusRef.current = newId
        }
        return
      }
      if (action === 'confirm') {
        if (source === 'gamepad' && textEntry && active instanceof HTMLElement) {
          const form = (active as HTMLInputElement | HTMLTextAreaElement).form
          if (form) {
            const submitBtn = form.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]')
            if (submitBtn && !submitBtn.hasAttribute('disabled')) {
              submitBtn.click()
              return
            }
          }
        }
        if (!textEntry && active instanceof HTMLElement) active.click()
        return
      }
      if (action === 'back') {
        if (textEntry && active instanceof HTMLElement) {
          active.blur()
          const currentId = managedFocusId(active)
          const validPrevious = lastNonTextFocusRef.current !== undefined
            && lastNonTextFocusRef.current !== currentId
            && graph.nodes.some(node => node.id === lastNonTextFocusRef.current)
          let targetId: string
          if (validPrevious && lastNonTextFocusRef.current !== undefined) {
            targetId = lastNonTextFocusRef.current
          } else {
            const nonTextNode = graph.nodes.find(node => node.id !== currentId && !isTextNodeId(node.id))
            targetId = nonTextNode?.id ?? graph.entryId
          }
          focusManagedElement(targetId)
          if (document.activeElement instanceof HTMLElement && !isTextEntry(document.activeElement)) {
            const newId = managedFocusId(document.activeElement)
            if (newId !== undefined) lastNonTextFocusRef.current = newId
          }
          return
        }
        onBack?.()
        return
      }
      if (action === 'scroll-up' || action === 'scroll-down') {
        scrollVisibleRegion(active, action === 'scroll-up' ? -SCROLL_STEP_PX : SCROLL_STEP_PX)
        return
      }
      if (action === 'command-center') onCommandCenter?.()
      if (action === 'pause-task') onPauseTask?.()
      if (action === 'primary-action' && (!textEntry || source === 'gamepad')) onPrimaryAction?.()
      if (action === 'more-actions' && (!textEntry || source === 'gamepad')) onMoreActions?.()
      if (action === 'previous-page' && (!textEntry || source === 'gamepad')) onPreviousPage?.()
      if (action === 'next-page' && (!textEntry || source === 'gamepad')) onNextPage?.()
      if (action === 'previous-project' && (!textEntry || source === 'gamepad')) optionsRef.current.onPreviousProject?.()
      if (action === 'next-project' && (!textEntry || source === 'gamepad')) optionsRef.current.onNextProject?.()
      if (action === 'previous-session' && (!textEntry || source === 'gamepad')) optionsRef.current.onPreviousSession?.()
      if (action === 'next-session' && (!textEntry || source === 'gamepad')) optionsRef.current.onNextSession?.()
      if (action === 'new-session' && (!textEntry || source === 'gamepad')) optionsRef.current.onNewSession?.()
      if (action === 'new-project' && (!textEntry || source === 'gamepad')) optionsRef.current.onNewProject?.()
      if (action === 'voice-input') optionsRef.current.onVoiceInput?.('press')
      if (action === 'voice-input-release') optionsRef.current.onVoiceInput?.('release')
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      const active = document.activeElement
      const isInput = isTextEntry(active)
      let multiline = false
      let isAtStart = false
      let isAtEnd = false

      if (active instanceof HTMLTextAreaElement) {
        multiline = true
        isAtStart = active.selectionStart === 0 && active.selectionEnd === 0
        isAtEnd = active.selectionStart === active.value.length && active.selectionEnd === active.value.length
      } else if (active instanceof HTMLInputElement) {
        multiline = false
      }

      const action = mapKeyboardAction({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        textEntry: isInput,
        multiline,
        isAtStart,
        isAtEnd,
      })
      if (action === undefined) return
      event.preventDefault()
      handleAction(action, 'keyboard')
    }

    const handleFocusIn = (event: FocusEvent): void => {
      const id = managedFocusId(event.target)
      if (id !== undefined && !isTextEntry(event.target)) lastNonTextFocusRef.current = id
    }

    const handlePointerDown = (event: MouseEvent | PointerEvent): void => {
      const target = event.target as Element | null
      const focusable = target?.closest<HTMLElement>('[data-focus-id]')
      if (focusable && !focusable.hasAttribute('disabled')) {
        const id = focusable.dataset.focusId
        if (id !== undefined) {
          focusable.focus()
          if (!isTextEntry(focusable)) {
            lastNonTextFocusRef.current = id
          }
        }
      }
    }

    const voiceInputButtonIndex = optionsRef.current.voiceInputGamepadButton
    const mapper = createGamepadMapper(
      voiceInputButtonIndex === undefined ? {} : { voiceInputButtonIndex },
    )
    let frame = 0
    const pollGamepads = (now: number): void => {
      const gamepad = navigator.getGamepads().find(candidate => candidate?.connected === true)
      if (gamepad === undefined || gamepad === null) {
        mapper.reset()
      } else {
        const actions = mapper.update({
          buttons: gamepad.buttons.map(button => button.pressed),
          axes: gamepad.axes,
        }, now)
        for (const action of actions) handleAction(action, 'gamepad')
      }
      frame = requestAnimationFrame(pollGamepads)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('focusin', handleFocusIn)
    window.addEventListener('pointerdown', handlePointerDown)
    frame = requestAnimationFrame(pollGamepads)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('focusin', handleFocusIn)
      window.removeEventListener('pointerdown', handlePointerDown)
      cancelAnimationFrame(frame)
    }
  }, [options.voiceInputGamepadButton])
}

export function focusManagedElement(id: string): boolean {
  const target = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-id]'))
    .find(element => element.dataset.focusId === id && !element.hasAttribute('disabled'))
  target?.focus()
  return target !== undefined
}

export function restoreManagedFocus(id: string): void {
  requestAnimationFrame(() => requestAnimationFrame(() => focusManagedElement(id)))
}

function managedFocusId(target: EventTarget | null): string | undefined {
  return target instanceof HTMLElement ? target.dataset.focusId : undefined
}

function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
}

function isTextNodeId(id: string): boolean {
  return id === 'task-input'
    || id === 'project-name'
    || id === 'api-key'
    || id === 'base-url'
    || id === 'codex-model'
    || id === 'commit-message'
}

export function scrollVisibleRegion(active: Element | null, delta: number): HTMLElement | undefined {
  const regions = Array.from(document.querySelectorAll<HTMLElement>('[data-scroll-region]'))
    .filter(isVisible)
  if (regions.length === 0) return undefined

  // 1. If an overlay/dialog modal is open (settings, project center, command center, approval, commit)
  const overlay = document.querySelector<HTMLElement>('.command-overlay, .settings-overlay, .project-overlay, [role="dialog"]')
  if (overlay && isVisible(overlay)) {
    const overlayRegion = regions.find(region => overlay.contains(region))
    if (overlayRegion !== undefined) {
      overlayRegion.scrollTop += delta
      return overlayRegion
    }
  }

  // 2. If focus is explicitly within a scroll region (e.g. inspector-files, inspector-diff, task-output)
  const focusedRegion = active?.closest<HTMLElement>('[data-scroll-region]')
  if (focusedRegion !== null && focusedRegion !== undefined && regions.includes(focusedRegion)) {
    focusedRegion.scrollTop += delta
    return focusedRegion
  }

  // 3. Otherwise in workspace view, prefer the active inspector content region
  const inspectorContent = regions.find(region => region.dataset.scrollRegion === 'inspector-diff')
    ?? regions.find(region => region.dataset.scrollRegion === 'inspector-activity')
    ?? regions.find(region => region.dataset.scrollRegion === 'inspector-artifacts')
    ?? regions.find(region => region.dataset.scrollRegion === 'inspector-files')

  if (inspectorContent !== undefined) {
    inspectorContent.scrollTop += delta
    return inspectorContent
  }

  // 4. Fallback to task output region or first scroll region
  const outputRegion = regions.find(region => region.dataset.scrollRegion === 'task-output' || region.dataset.scrollRegion === 'task')
  const target = outputRegion ?? regions[0]
  if (target !== undefined) {
    target.scrollTop += delta
    return target
  }
  return undefined
}

function isVisible(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current !== null; current = current.parentElement) {
    const style = window.getComputedStyle(current)
    if (current.hidden
      || current.getAttribute('aria-hidden') === 'true'
      || style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse') return false
  }
  return true
}
