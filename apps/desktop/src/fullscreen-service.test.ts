import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  isWindowFullscreen,
  setWindowFullscreen,
  toggleWindowFullscreen,
  subscribeFullscreenChange,
} from './fullscreen-service.ts'

describe('fullscreen-service', () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document

  let listeners: Record<string, ((event?: unknown) => void)[]> = {}
  let mockFullscreenElement: unknown = null

  beforeEach(() => {
    vi.restoreAllMocks()
    listeners = {}
    mockFullscreenElement = null

    const mockDoc = {
      get fullscreenElement() {
        return mockFullscreenElement
      },
      documentElement: {
        requestFullscreen: vi.fn().mockImplementation(async () => {
          mockFullscreenElement = mockDoc.documentElement
        }),
      },
      exitFullscreen: vi.fn().mockImplementation(async () => {
        mockFullscreenElement = null
      }),
      addEventListener: vi.fn().mockImplementation((type: string, listener: () => void) => {
        listeners[type] = listeners[type] || []
        listeners[type].push(listener)
      }),
      removeEventListener: vi.fn().mockImplementation((type: string, listener: () => void) => {
        listeners[type] = (listeners[type] || []).filter(item => item !== listener)
      }),
      dispatchEvent: vi.fn().mockImplementation((event: { type: string }) => {
        for (const listener of listeners[event.type] || []) {
          listener(event)
        }
        return true
      }),
    }

    const mockWin = {
      addEventListener: vi.fn().mockImplementation((type: string, listener: () => void) => {
        listeners[type] = listeners[type] || []
        listeners[type].push(listener)
      }),
      removeEventListener: vi.fn().mockImplementation((type: string, listener: () => void) => {
        listeners[type] = (listeners[type] || []).filter(item => item !== listener)
      }),
      document: mockDoc,
    }

    // @ts-expect-error mock window
    globalThis.window = mockWin
    // @ts-expect-error mock document
    globalThis.document = mockDoc
  })

  afterEach(() => {
    globalThis.window = originalWindow
    globalThis.document = originalDocument
  })

  it('在无全屏元素时返回 false', async () => {
    mockFullscreenElement = null
    const isFs = await isWindowFullscreen()
    expect(isFs).toBe(false)
  })

  it('在存在全屏元素时返回 true', async () => {
    mockFullscreenElement = {}
    const isFs = await isWindowFullscreen()
    expect(isFs).toBe(true)
  })

  it('调用 toggleWindowFullscreen 进入和退出全屏', async () => {
    // 当前非全屏，切换进入全屏
    const result1 = await toggleWindowFullscreen()
    expect(document.documentElement.requestFullscreen).toHaveBeenCalled()
    expect(result1).toBe(true)

    // 当前全屏，切换退出全屏
    const result2 = await toggleWindowFullscreen()
    expect(document.exitFullscreen).toHaveBeenCalled()
    expect(result2).toBe(false)
  })

  it('直接调用 setWindowFullscreen 设置指定全屏状态', async () => {
    const enterResult = await setWindowFullscreen(true)
    expect(document.documentElement.requestFullscreen).toHaveBeenCalled()
    expect(enterResult).toBe(true)

    const exitResult = await setWindowFullscreen(false)
    expect(document.exitFullscreen).toHaveBeenCalled()
    expect(exitResult).toBe(false)
  })

  it('订阅全屏状态变更通知', async () => {
    const callback = vi.fn()
    const unsubscribe = subscribeFullscreenChange(callback)

    // 等待初始读取
    await Promise.resolve()
    expect(callback).toHaveBeenCalledWith(false)

    // 触发 fullscreenchange 事件
    mockFullscreenElement = document.documentElement
    document.dispatchEvent({ type: 'fullscreenchange' } as Event)
    await Promise.resolve()
    expect(callback).toHaveBeenCalledWith(true)

    unsubscribe()
  })
})
