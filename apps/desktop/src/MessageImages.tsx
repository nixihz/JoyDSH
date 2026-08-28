import { useState, useEffect, memo, useCallback } from 'react'
import type { MessageImageItem } from '@joydsh/domain'
import type { DshAdapter } from '@joydsh/dsh-adapter'
import type { LightboxImage } from './ImageLightbox.tsx'
import { LoaderCircle, AlertCircle, RefreshCw, FileImage } from 'lucide-react'

// Memory cache for session attachments across component re-renders
const attachmentDataCache = new Map<string, string>()

function attachmentCacheKey(taskId: string, attachmentId: string): string {
  return `${taskId}:${attachmentId}`
}

export interface MessageImagesProps {
  images: readonly MessageImageItem[]
  taskId?: string | undefined
  adapter?: DshAdapter | undefined
  onPreviewImage: (image: LightboxImage) => void
}

interface SingleImageItemProps {
  item: MessageImageItem
  taskId: string | undefined
  adapter: DshAdapter | undefined
  variant: 'single' | 'tile'
  onPreviewImage: (image: LightboxImage) => void
}

function SingleImageItem({ item, taskId, adapter, variant, onPreviewImage }: SingleImageItemProps) {
  const [dataUrl, setDataUrl] = useState<string | undefined>(() => {
    if (item.dataUrl) return item.dataUrl
    if (item.attachmentId && taskId) {
      return attachmentDataCache.get(attachmentCacheKey(taskId, item.attachmentId))
    }
    return undefined
  })
  const [loading, setLoading] = useState<boolean>(!dataUrl && Boolean(item.attachmentId && adapter && taskId))
  const [error, setError] = useState<boolean>(false)

  const loadAttachment = useCallback(async () => {
    if (!item.attachmentId || !adapter || !taskId) return
    const cacheKey = attachmentCacheKey(taskId, item.attachmentId)
    if (attachmentDataCache.has(cacheKey)) {
      setDataUrl(attachmentDataCache.get(cacheKey))
      setLoading(false)
      return
    }

    setLoading(true)
    setError(false)
    try {
      const res = await adapter.getAttachment(taskId, item.attachmentId)
      const mime = res.attachment.mediaType || item.mediaType || 'image/png'
      const url = res.data.startsWith('data:') ? res.data : `data:${mime};base64,${res.data}`
      attachmentDataCache.set(cacheKey, url)
      setDataUrl(url)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [item.attachmentId, item.mediaType, adapter, taskId])

  useEffect(() => {
    if (item.dataUrl) {
      setDataUrl(item.dataUrl)
      setLoading(false)
      return
    }
    if (!dataUrl && item.attachmentId && adapter && taskId) {
      void loadAttachment()
    }
  }, [item.dataUrl, item.attachmentId, adapter, taskId, dataUrl, loadAttachment])

  const handleClick = () => {
    if (!dataUrl) return
    onPreviewImage({
      src: dataUrl,
      name: item.name,
      width: item.width,
      height: item.height,
      bytes: item.bytes,
      alt: item.name || '图片',
    })
  }

  const isSingle = variant === 'single'
  const displayName = item.name || '图片'

  if (loading) {
    return (
      <div className={`message-image-item message-image-item--loading ${isSingle ? 'message-image-item--single' : 'message-image-item--tile'}`}>
        <LoaderCircle className="spin-icon message-image-icon" aria-hidden="true" />
        {isSingle ? <span className="message-image-loading-text">加载图片中...</span> : null}
      </div>
    )
  }

  if (error || (!dataUrl && !loading)) {
    return (
      <div className={`message-image-item message-image-item--error ${isSingle ? 'message-image-item--single' : 'message-image-item--tile'}`}>
        <AlertCircle className="message-image-icon" aria-hidden="true" />
        <span className="message-image-error-text">{displayName}</span>
        {item.attachmentId && adapter && taskId ? (
          <button type="button" className="message-image-retry-btn" onClick={() => void loadAttachment()} title="重新加载">
            <RefreshCw aria-hidden="true" />
            重试
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={`message-image-item ${isSingle ? 'message-image-item--single' : 'message-image-item--tile'}`}
      onClick={handleClick}
      title={`点击放大查看: ${displayName}`}
      aria-label={`查看原图: ${displayName}`}
    >
      <img
        src={dataUrl}
        alt={displayName}
        className="message-image-img"
        loading="lazy"
      />
      {isSingle && item.name ? (
        <span className="message-image-caption" title={item.name}>{item.name}</span>
      ) : null}
    </button>
  )
}

export const MessageImages = memo(function MessageImages({
  images,
  taskId,
  adapter,
  onPreviewImage,
}: MessageImagesProps) {
  if (images.length === 0) return null

  const isSingle = images.length === 1

  return (
    <div className={`message-images-container ${isSingle ? 'message-images--single' : 'message-images--gallery'}`}>
      {images.map((img, idx) => (
        <SingleImageItem
          key={img.id || img.attachmentId || idx}
          item={img}
          taskId={taskId}
          adapter={adapter}
          variant={isSingle ? 'single' : 'tile'}
          onPreviewImage={onPreviewImage}
        />
      ))}
    </div>
  )
})
