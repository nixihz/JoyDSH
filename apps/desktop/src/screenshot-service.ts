import { invoke, isTauri } from '@tauri-apps/api/core'

/** 捕获当前 JoyDSH 窗口的一帧图像。 */
export async function captureScreenImage(): Promise<string> {
  if (isTauri()) {
    const dataUrl = await invoke<string>('capture_screen')
    if (dataUrl.startsWith('data:image/png;base64,')) return dataUrl
    throw new Error('原生截图返回了无效数据')
  }

  return captureDisplayWindow()
}

async function captureDisplayWindow(): Promise<string> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('当前环境不支持截取 JoyDSH 窗口')
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'window' },
    audio: false,
  })
  try {
    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('窗口捕获没有返回视频轨道')
    return await captureTrackFrame(stream, track)
  } finally {
    for (const track of stream.getTracks()) track.stop()
  }
}

async function captureTrackFrame(stream: MediaStream, track: MediaStreamTrack): Promise<string> {
  const ImageCaptureConstructor = (window as unknown as {
    ImageCapture?: new (track: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> }
  }).ImageCapture
  if (ImageCaptureConstructor !== undefined) {
    const bitmap = await new ImageCaptureConstructor(track).grabFrame()
    return drawImageToDataUrl(bitmap, bitmap.width, bitmap.height)
  }

  return captureVideoFrame(stream)
}

async function captureVideoFrame(stream: MediaStream): Promise<string> {
  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  video.muted = true
  video.srcObject = stream
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => video.play().then(() => resolve(), reject)
    video.onerror = () => reject(new Error('无法读取窗口捕获视频'))
  })
  return drawImageToDataUrl(video, video.videoWidth, video.videoHeight)
}

function drawImageToDataUrl(image: CanvasImageSource, width: number, height: number): string {
  if (width <= 0 || height <= 0) throw new Error('窗口截图尺寸无效')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建窗口截图画布')
  context.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:(image\/png);base64,(.+)$/.exec(dataUrl)
  if (!match) throw new Error('截图数据不是有效的 PNG Data URL')
  const bytes = Uint8Array.from(atob(match[2]!), character => character.charCodeAt(0))
  return new Blob([bytes], { type: match[1]! })
}

/** 复制图片 Blob 到系统剪贴板。 */
export async function writeImageToClipboard(blob: Blob): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.write) return false
  try {
    if (typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    } else {
      await navigator.clipboard.write([{ 'image/png': blob } as unknown as ClipboardItem])
    }
    return true
  } catch {
    return false
  }
}

/** 从系统剪贴板读取第一张图片。 */
export async function readImageFromClipboard(): Promise<File | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return null
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      for (const type of item.types) {
        if (!type.startsWith('image/')) continue
        const blob = await item.getType(type)
        const extension = type.split('/')[1] || 'png'
        return new File([blob], `clipboard-image-${Date.now()}.${extension}`, { type })
      }
    }
  } catch {
    return null
  }
  return null
}
