import { describe, expect, it, vi } from 'vitest'
import {
  AUTO_SCROLL_THRESHOLD,
  isScrolledNearBottom,
  scrollElementToBottom,
} from './output-scroll.ts'

describe('output-scroll 单元测试', () => {
  describe('isScrolledNearBottom', () => {
    it('恰好处于最底部时返回 true', () => {
      expect(
        isScrolledNearBottom({
          scrollHeight: 1000,
          scrollTop: 600,
          clientHeight: 400,
        }),
      ).toBe(true)
    })

    it('处于阈值范围内（如差 30px）时返回 true', () => {
      expect(
        isScrolledNearBottom({
          scrollHeight: 1000,
          scrollTop: 570,
          clientHeight: 400,
        }),
      ).toBe(true)
    })

    it('处于阈值临界点（48px）时返回 true', () => {
      expect(
        isScrolledNearBottom({
          scrollHeight: 1000,
          scrollTop: 1000 - 400 - AUTO_SCROLL_THRESHOLD,
          clientHeight: 400,
        }),
      ).toBe(true)
    })

    it('超出阈值范围（如向上滚动 100px）时返回 false', () => {
      expect(
        isScrolledNearBottom({
          scrollHeight: 1000,
          scrollTop: 500,
          clientHeight: 400,
        }),
      ).toBe(false)
    })

    it('支持自定义阈值', () => {
      expect(
        isScrolledNearBottom(
          {
            scrollHeight: 1000,
            scrollTop: 550,
            clientHeight: 400,
          },
          60,
        ),
      ).toBe(true)

      expect(
        isScrolledNearBottom(
          {
            scrollHeight: 1000,
            scrollTop: 550,
            clientHeight: 400,
          },
          30,
        ),
      ).toBe(false)
    })
  })

  describe('scrollElementToBottom', () => {
    it('非平滑模式下直接赋值 scrollTop = scrollHeight', () => {
      const mockElement = {
        scrollHeight: 1200,
        scrollTop: 200,
      } as HTMLElement

      scrollElementToBottom(mockElement, false)
      expect(mockElement.scrollTop).toBe(1200)
    })

    it('平滑模式下调用 scrollTo', () => {
      const scrollToMock = vi.fn()
      const mockElement = {
        scrollHeight: 1500,
        scrollTop: 100,
        scrollTo: scrollToMock,
      } as unknown as HTMLElement

      scrollElementToBottom(mockElement, true)
      expect(scrollToMock).toHaveBeenCalledWith({
        top: 1500,
        behavior: 'smooth',
      })
    })

    it('平滑模式但元素无 scrollTo 方法时降级为直接赋值', () => {
      const mockElement = {
        scrollHeight: 1600,
        scrollTop: 300,
      } as HTMLElement

      scrollElementToBottom(mockElement, true)
      expect(mockElement.scrollTop).toBe(1600)
    })

    it('对 null 或 undefined 调用时不抛错', () => {
      expect(() => scrollElementToBottom(null)).not.toThrow()
      expect(() => scrollElementToBottom(undefined)).not.toThrow()
    })
  })
})
