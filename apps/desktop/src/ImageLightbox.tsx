import { useEffect, useCallback, useState } from 'react'
import { RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'

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
  const [zoom, setZoom] = useState(1)
  const [baseSize, setBaseSize] = useState<{ width: number, height: number } | undefined>()

  useEffect(() => {
    setZoom(1)
    setBaseSize(undefined)
  }, [image?.src])

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
  const zoomPercent = Math.round(zoom * 100)
  const changeZoom = (delta: number) => setZoom(current => Math.min(3, Math.max(0.5, current + delta)))

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
              className="image-lightbox-action"
              data-focus-id="lightbox-zoom-out"
              onClick={() => changeZoom(-0.25)}
              aria-label="缩小图片"
              title="缩小"
            >
              <ZoomOut aria-hidden="true" />
            </button>
            <button
              type="button"
              className="image-lightbox-action image-lightbox-reset"
              data-focus-id="lightbox-reset"
              onClick={() => setZoom(1)}
              aria-label="恢复图片原始缩放"
              title="恢复缩放"
            >
              <RotateCcw aria-hidden="true" />
              <span>{zoomPercent}%</span>
            </button>
            <button
              type="button"
              className="image-lightbox-action"
              data-focus-id="lightbox-zoom-in"
              onClick={() => changeZoom(0.25)}
              aria-label="放大图片"
              title="放大"
            >
              <ZoomIn aria-hidden="true" />
            </button>
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

        <div className="image-lightbox-viewport" data-scroll-region="lightbox" onClick={handleBackdropClick}>
          <div className="image-lightbox-stage" onClick={handleBackdropClick}>
            <img
              className="image-lightbox-img"
              src={image.src}
              alt={displayName}
              draggable={false}
              onLoad={event => {
                const naturalWidth = event.currentTarget.naturalWidth
                const naturalHeight = event.currentTarget.naturalHeight
                if (naturalWidth <= 0 || naturalHeight <= 0) return
                const fitScale = Math.min(
                  1,
                  (window.innerWidth * 0.9) / naturalWidth,
                  (window.innerHeight * 0.84) / naturalHeight,
                )
                setBaseSize({ width: naturalWidth * fitScale, height: naturalHeight * fitScale })
              }}
              style={baseSize === undefined ? undefined : {
                width: `${baseSize.width * zoom}px`,
                height: `${baseSize.height * zoom}px`,
                maxWidth: 'none',
                maxHeight: 'none',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
