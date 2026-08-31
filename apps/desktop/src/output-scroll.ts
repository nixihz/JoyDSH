import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export const AUTO_SCROLL_THRESHOLD = 48

export interface ScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/**
 * 判断当前滚动位置是否处于底部（或在阈值容差范围内）
 */
export function isScrolledNearBottom(
  metrics: ScrollMetrics,
  threshold = AUTO_SCROLL_THRESHOLD,
): boolean {
  const { scrollHeight, scrollTop, clientHeight } = metrics
  return scrollHeight - scrollTop - clientHeight <= threshold
}

/**
 * 将可滚动元素滚动到底部
 */
export function scrollElementToBottom(
  element: HTMLElement | null | undefined,
  smooth = false,
): void {
  if (!element) return
  if (smooth && typeof element.scrollTo === 'function') {
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  } else {
    element.scrollTop = element.scrollHeight
  }
}

export interface UseOutputScrollOptions {
  activeTaskId?: string | undefined
  dependencies?: unknown[] | undefined
  threshold?: number | undefined
}

export interface UseOutputScrollResult {
  isScrolledToBottom: boolean
  scrollToBottom: (smooth?: boolean) => void
  handleScroll: () => void
  resetToBottom: (smooth?: boolean) => void
}

/**
 * 管理聊天会话输出区域的智能自动滚动：
 * - 当用户停留在底部时，随内容流式输出自动保持在最下方
 * - 当用户向上滚动查看历史内容时，不强行打断用户回看，保持当前滚动位置
 * - 切换任务会话或发送新输入时，自动重置并滚动到底部
 */
export function useOutputScroll(
  ref: RefObject<HTMLElement | null>,
  options: UseOutputScrollOptions = {},
): UseOutputScrollResult {
  const { activeTaskId, dependencies = [], threshold = AUTO_SCROLL_THRESHOLD } = options
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true)
  const isAtBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const atBottom = isScrolledNearBottom(el, threshold)
    isAtBottomRef.current = atBottom
    setIsScrolledToBottom(atBottom)
  }, [ref, threshold])

  const scrollToBottom = useCallback((smooth = true) => {
    const el = ref.current
    if (!el) return
    isAtBottomRef.current = true
    setIsScrolledToBottom(true)
    scrollElementToBottom(el, smooth)
  }, [ref])

  // 当任务会话切换时，重置为自动滚动到底部
  useEffect(() => {
    isAtBottomRef.current = true
    setIsScrolledToBottom(true)
    const el = ref.current
    if (el) {
      scrollElementToBottom(el, false)
    }
  }, [activeTaskId, ref])

  // 当输出、状态或消息依赖项更新时，仅在用户处于底部时自动跟进滚动
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (isAtBottomRef.current) {
      scrollElementToBottom(el, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, ref])

  return {
    isScrolledToBottom,
    scrollToBottom,
    handleScroll,
    resetToBottom: scrollToBottom,
  }
}
