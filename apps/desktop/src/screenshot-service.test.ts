import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { captureScreenImage, dataUrlToBlob, writeImageToClipboard } from './screenshot-service.ts'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)
const isTauriMock = vi.mocked(isTauri)

describe('当前页面截图服务', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('在 Tauri WebView 中调用原生当前窗口截图命令', async () => {
    const dataUrl = 'data:image/png;base64,aGVsbG8='
    isTauriMock.mockReturnValue(true)
    invokeMock.mockResolvedValue(dataUrl)

    await expect(captureScreenImage()).resolves.toBe(dataUrl)
    expect(invokeMock).toHaveBeenCalledWith('capture_screen')
  })

  it('原生截图失败时保留真实错误', async () => {
    const nativeError = new Error('屏幕录制权限未授权')
    isTauriMock.mockReturnValue(true)
    invokeMock.mockRejectedValue(nativeError)

    await expect(captureScreenImage()).rejects.toBe(nativeError)
  })

  it('将 PNG Data URL 转换为可发送的图片 Blob', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,aGVsbG8=')

    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(5)
    expect(await blob.text()).toBe('hello')
  })

  it('拒绝非 PNG 截图数据', () => {
    expect(() => dataUrlToBlob('data:text/plain;base64,aGVsbG8=')).toThrow(
      '截图数据不是有效的 PNG Data URL',
    )
  })

  it('准确报告系统剪贴板写入结果', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { write } })
    vi.stubGlobal('ClipboardItem', class ClipboardItem {
      constructor(public readonly items: Record<string, Blob>) {}
    })

    await expect(writeImageToClipboard(new Blob(['png'], { type: 'image/png' }))).resolves.toBe(true)
    expect(write).toHaveBeenCalledOnce()

    write.mockRejectedValueOnce(new Error('permission denied'))
    await expect(writeImageToClipboard(new Blob(['png'], { type: 'image/png' }))).resolves.toBe(false)
  })
})
