import { useEffect, useRef } from 'react'
import { moveFocus, restoreFocus, type FocusGraph, type FocusMove } from '@joydsh/focus'
import { createGamepadMapper, mapKeyboardAction, type SemanticAction } from '@joydsh/input'

export interface SemanticNavigationOptions {
  graph: FocusGraph
  enabled?: boolean
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
  onScreenshot?(): void
  screenshotGamepadButton?: number
  onOpenSelect?(select: HTMLSelectElement): void
}

type InputSource = 'gamepad' | 'keyboard'

export function mapVoiceInputTrigger(
  action: SemanticAction,
  source: InputSource,
): 'tap' | 'press' | 'release' | undefined {
  if (action === 'voice-input') return source === 'gamepad' ? 'press' : 'tap'
  if (action === 'voice-input-release' && source === 'gamepad') return 'release'
  return undefined
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
  const pointerTargetRef = useRef<Element | null>(null)
  const isGamepadModeRef = useRef<boolean>(false)
  const lastPointerPosRef = useRef<{ x: number; y: number }>({ x: -1, y: -1 })
  optionsRef.current = options

  useEffect(() => {
    if (options.enabled === false) return
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
  }, [options.enabled, options.graph])

  useEffect(() => {
    if (options.enabled === false) return
    const setGamepadMode = (enabled: boolean): void => {
      if (isGamepadModeRef.current === enabled) return
      isGamepadModeRef.current = enabled
      if (typeof document !== 'undefined') {
        if (enabled) {
          document.documentElement.classList.add('gamepad-mode')
          document.body?.classList.add('gamepad-mode')
          pointerTargetRef.current = null
        } else {
          document.documentElement.classList.remove('gamepad-mode')
          document.body?.classList.remove('gamepad-mode')
        }
      }
    }

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

    const handleAction = (action: SemanticAction, source: InputSource = 'keyboard'): void => {
      if (source === 'gamepad') {
        setGamepadMode(true)
      }
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
        if (source === 'gamepad' && active instanceof HTMLSelectElement && (action === 'move-left' || action === 'move-right')) {
          adjustSelectValue(active, action === 'move-left' ? -1 : 1)
          return
        }
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
        activateFocusedElement(active, source, optionsRef.current.onOpenSelect)
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
        const pointerTarget = isGamepadModeRef.current ? null : pointerTargetRef.current
        scrollVisibleRegion(active, action === 'scroll-up' ? -SCROLL_STEP_PX : SCROLL_STEP_PX, pointerTarget)
        return
      }
      if (action === 'scroll-left' || action === 'scroll-right') {
        const pointerTarget = isGamepadModeRef.current ? null : pointerTargetRef.current
        scrollVisibleRegion(active, 0, pointerTarget, action === 'scroll-left' ? -SCROLL_STEP_PX : SCROLL_STEP_PX)
        return
      }
      if (action === 'command-center') onCommandCenter?.()
      if (action === 'pause-task') onPauseTask?.()
      if (action === 'screenshot') {
        optionsRef.current.onScreenshot?.()
        return
      }
      if (action === 'primary-action' && source === 'gamepad' && isEditableTextEntry(active)) {
        deleteBackwardFromTextEntry(active)
        return
      }
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
      const voiceInputTrigger = mapVoiceInputTrigger(action, source)
      if (voiceInputTrigger !== undefined) optionsRef.current.onVoiceInput?.(voiceInputTrigger)
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
      if (action === 'voice-input' && event.repeat) return
      handleAction(action, 'keyboard')
    }

    const handleFocusIn = (event: FocusEvent): void => {
      const id = managedFocusId(event.target)
      if (id !== undefined && !isTextEntry(event.target)) lastNonTextFocusRef.current = id
    }

    const handlePointerDown = (event: MouseEvent | PointerEvent): void => {
      setGamepadMode(false)
      pointerTargetRef.current = event.target instanceof Element ? event.target : null
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

    const handlePointerMove = (event: PointerEvent): void => {
      if (lastPointerPosRef.current.x !== -1 && lastPointerPosRef.current.y !== -1) {
        const dx = Math.abs(event.clientX - lastPointerPosRef.current.x)
        const dy = Math.abs(event.clientY - lastPointerPosRef.current.y)
        if (dx > 2 || dy > 2) {
          setGamepadMode(false)
          pointerTargetRef.current = event.target instanceof Element ? event.target : null
          lastPointerPosRef.current = { x: event.clientX, y: event.clientY }
        }
      } else {
        lastPointerPosRef.current = { x: event.clientX, y: event.clientY }
      }
    }

    const voiceInputButtonIndex = optionsRef.current.voiceInputGamepadButton
    const screenshotButtonIndex = optionsRef.current.screenshotGamepadButton
    const mapper = createGamepadMapper({
      ...(voiceInputButtonIndex !== undefined ? { voiceInputButtonIndex } : {}),
      ...(screenshotButtonIndex !== undefined ? { screenshotButtonIndex } : {}),
    })
    let frame = 0
    const pollGamepads = (now: number): void => {
      const gamepad = navigator.getGamepads().find(candidate => candidate?.connected === true)
      if (gamepad === undefined || gamepad === null) {
        for (const action of mapper.reset()) handleAction(action, 'gamepad')
      } else {
        const isInteracting = gamepad.buttons.some(b => b.pressed || b.value > 0.2)
          || gamepad.axes.some(a => Math.abs(a) > 0.2)
        if (isInteracting) {
          setGamepadMode(true)
        }
        const actions = mapper.update({
          buttons: gamepad.buttons.map(button => button.pressed),
          axes: gamepad.axes,
        }, now)
        for (const action of actions) handleAction(action, 'gamepad')
      }
      frame = requestAnimationFrame(pollGamepads)
    }

    const handlePointerOver = (event: PointerEvent): void => {
      if (!isGamepadModeRef.current) {
        pointerTargetRef.current = event.target instanceof Element ? event.target : null
      }
    }

    const handlePointerLeave = (): void => {
      pointerTargetRef.current = null
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('focusin', handleFocusIn)
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerover', handlePointerOver)
    document.documentElement.addEventListener('pointerleave', handlePointerLeave)
    frame = requestAnimationFrame(pollGamepads)
    return () => {
      setGamepadMode(false)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('focusin', handleFocusIn)
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerover', handlePointerOver)
      document.documentElement.removeEventListener('pointerleave', handlePointerLeave)
      cancelAnimationFrame(frame)
      for (const action of mapper.reset()) handleAction(action, 'gamepad')
    }
  }, [options.enabled, options.screenshotGamepadButton, options.voiceInputGamepadButton])
}

export function activateFocusedElement(
  active: HTMLElement | null,
  source: InputSource,
  onOpenSelect?: (select: HTMLSelectElement) => void,
): void {
  const textEntry = isTextEntry(active)
  if (source === 'gamepad' && active instanceof HTMLSelectElement) {
    onOpenSelect?.(active)
    return
  }
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
}

export function adjustSelectValue(select: HTMLSelectElement, direction: -1 | 1): boolean {
  const options = Array.from(select.options)
  let index = select.selectedIndex
  do {
    index += direction
  } while (index >= 0 && index < options.length && options[index]?.disabled === true)
  if (index < 0 || index >= options.length || index === select.selectedIndex) return false
  select.selectedIndex = index
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

export function deleteBackwardFromTextEntry(
  entry: HTMLInputElement | HTMLTextAreaElement,
): boolean {
  if (entry.disabled || entry.readOnly) return false
  const selectionStart = entry.selectionStart
  const selectionEnd = entry.selectionEnd
  if (selectionStart === null || selectionEnd === null) return false

  const deleteStart = selectionStart === selectionEnd
    ? previousCodePointBoundary(entry.value, selectionStart)
    : selectionStart
  if (deleteStart === selectionEnd) return false

  entry.setRangeText('', deleteStart, selectionEnd, 'end')
  entry.dispatchEvent(new Event('input', { bubbles: true }))
  return true
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

function isEditableTextEntry(
  target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
}

function previousCodePointBoundary(value: string, offset: number): number {
  if (offset === 0) return 0
  const previous = value.charCodeAt(offset - 1)
  const beforePrevious = offset > 1 ? value.charCodeAt(offset - 2) : 0
  const followsHighSurrogate = previous >= 0xdc00
    && previous <= 0xdfff
    && beforePrevious >= 0xd800
    && beforePrevious <= 0xdbff
  return followsHighSurrogate ? offset - 2 : offset - 1
}

function isTextNodeId(id: string): boolean {
  return id === 'task-input'
    || id === 'project-name'
    || id === 'api-key'
    || id === 'base-url'
    || id === 'codex-model'
    || id === 'commit-message'
}

export function scrollVisibleRegion(
  active: Element | null,
  delta: number,
  pointerTarget: Element | null = null,
  horizontalDelta = 0,
): HTMLElement | undefined {
  const regions = Array.from(document.querySelectorAll<HTMLElement>('[data-scroll-region]'))
    .filter(isVisible)
  if (regions.length === 0) return undefined

  // 1. If an overlay/dialog modal is open (settings, project center, command center, approval, commit)
  const overlay = document.querySelector<HTMLElement>('.command-overlay, .settings-overlay, .project-overlay, [role="dialog"]')
  if (overlay && isVisible(overlay)) {
    const overlayRegion = regions.find(region => overlay.contains(region))
    if (overlayRegion !== undefined) {
      scrollRegionBy(overlayRegion, delta, horizontalDelta)
      return overlayRegion
    }
  }

  // 2. Route scrolling to the region under the pointer, even when its contents are not focusable.
  const pointerRegion = pointerTarget?.closest<HTMLElement>('[data-scroll-region]')
  if (pointerRegion !== null && pointerRegion !== undefined && regions.includes(pointerRegion)) {
    scrollRegionBy(pointerRegion, delta, horizontalDelta)
    return pointerRegion
  }

  // 3. If focus is explicitly within a scroll region (e.g. inspector-files, inspector-diff, task-output)
  const focusedRegion = active?.closest<HTMLElement>('[data-scroll-region]')
  if (focusedRegion !== null && focusedRegion !== undefined && regions.includes(focusedRegion)) {
    scrollRegionBy(focusedRegion, delta, horizontalDelta)
    return focusedRegion
  }

  // 4. Otherwise in workspace view, prefer the active inspector content region
  const inspectorContent = regions.find(region => region.dataset.scrollRegion === 'inspector-diff')
    ?? regions.find(region => region.dataset.scrollRegion === 'inspector-activity')
    ?? regions.find(region => region.dataset.scrollRegion === 'inspector-artifacts')
    ?? regions.find(region => region.dataset.scrollRegion === 'inspector-files')

  if (inspectorContent !== undefined) {
    scrollRegionBy(inspectorContent, delta, horizontalDelta)
    return inspectorContent
  }

  // 5. Fallback to task output region or first scroll region
  const outputRegion = regions.find(region => region.dataset.scrollRegion === 'task-output' || region.dataset.scrollRegion === 'task')
  const target = outputRegion ?? regions[0]
  if (target !== undefined) {
    scrollRegionBy(target, delta, horizontalDelta)
    return target
  }
  return undefined
}

function scrollRegionBy(region: HTMLElement, verticalDelta: number, horizontalDelta: number): void {
  if (verticalDelta !== 0) region.scrollTop += verticalDelta
  if (horizontalDelta !== 0) region.scrollLeft += horizontalDelta
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
