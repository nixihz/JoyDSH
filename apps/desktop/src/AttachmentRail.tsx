import { memo } from 'react'
import type { ImageAttachmentInput } from '@joydsh/domain'
import { X, FileImage } from 'lucide-react'

export interface AttachmentRailProps {
  images: readonly ImageAttachmentInput[]
  onRemove: (id: string) => void
  onPreview: (image: ImageAttachmentInput) => void
}

function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined || Number.isNaN(bytes)) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const AttachmentRail = memo(function AttachmentRail({
  images,
  onRemove,
  onPreview,
}: AttachmentRailProps) {
  if (images.length === 0) return null

  return (
    <div className="attachment-rail" aria-label="待发送图片附件">
      <div className="attachment-rail__track">
        {images.map(img => {
          const sizeText = formatBytes(img.size)
          return (
            <div key={img.id} className="attachment-card" title={img.name || '图片附件'}>
              <button
                type="button"
                className="attachment-card__thumb"
                onClick={() => onPreview(img)}
                aria-label={`预览 ${img.name || '图片'}`}
              >
                {img.data ? (
                  <img
                    src={img.data.startsWith('data:') ? img.data : `data:${img.mediaType};base64,${img.data}`}
                    alt={img.name || '附件'}
                    className="attachment-card__img"
                  />
                ) : (
                  <FileImage className="attachment-card__fallback-icon" aria-hidden="true" />
                )}
              </button>
              <div className="attachment-card__info">
                <span className="attachment-card__name">{img.name || '图片'}</span>
                {sizeText ? <span className="attachment-card__size">{sizeText}</span> : null}
              </div>
              <button
                type="button"
                className="attachment-card__remove"
                data-focus-id={`attachment-remove-${img.id}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(img.id)
                }}
                aria-label={`移除 ${img.name || '图片'}`}
                title="移除"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
})
