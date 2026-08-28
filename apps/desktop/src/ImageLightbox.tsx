import { useEffect, useCallback } from 'react'
import { X } from 'lucide-react'

export interface LightboxImage {
  src: string
  alt?: string | undefined
  title?: string | undefined
  name?: string | undefined
  width?: number | undefined
  height?: number | undefined
  bytes?: number | undefined
}

export interface ImageLightboxProps {
  image: LightboxImage | null
  onClose: () => void
}

function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined || Number.isNaN(bytes)) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ImageLightbox({ image, onClose }: ImageLightboxProps) {
  useEffect(() => {
    if (!image) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [image, onClose])

  const handleBackdropClick = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }, [onClose])

  if (!image) return null

  const sizeText = formatBytes(image.bytes)
  const dimensionText = image.width && image.height ? `${image.width} × ${image.height}` : undefined
  const metaText = [dimensionText, sizeText].filter(Boolean).join(' • ')
  const displayName = image.name || image.title || image.alt || '图片预览'

  return (
    <div
      className="image-lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={displayName}
      onClick={handleBackdropClick}
    >
      <div className="image-lightbox-container">
        <header className="image-lightbox-header">
          <div className="image-lightbox-title-wrap">
            <span className="image-lightbox-title" title={displayName}>
              {displayName}
            </span>
            {metaText ? <span className="image-lightbox-meta">{metaText}</span> : null}
          </div>
          <div className="image-lightbox-actions">
            <button
              type="button"
              className="image-lightbox-close"
              data-focus-id="lightbox-close"
              onClick={onClose}
              aria-label="关闭原图预览 (Escape)"
              title="关闭 (Escape)"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="image-lightbox-viewport" onClick={handleBackdropClick}>
          <img
            className="image-lightbox-img"
            src={image.src}
            alt={displayName}
            draggable={false}
          />
        </div>
      </div>
    </div>
  )
}
