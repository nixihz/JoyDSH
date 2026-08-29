import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { ImageLightbox } from './ImageLightbox.tsx'

describe('ImageLightbox', () => {
  it('为手柄提供缩放、复位、关闭与语义滚动控件', () => {
    const html = renderToString(
      <ImageLightbox
        image={{ src: 'data:image/png;base64,AAAA', name: '预览图.png', width: 800, height: 600 }}
        onClose={vi.fn()}
      />,
    )

    expect(html).toContain('data-focus-id="lightbox-zoom-out"')
    expect(html).toContain('data-focus-id="lightbox-reset"')
    expect(html).toContain('data-focus-id="lightbox-zoom-in"')
    expect(html).toContain('data-focus-id="lightbox-close"')
    expect(html).toContain('data-scroll-region="lightbox"')
    expect(html).toContain('<span>100')
    expect(html).toContain('%</span>')
  })

  it('没有图片时不渲染灯箱', () => {
    expect(renderToString(<ImageLightbox image={null} onClose={vi.fn()} />)).toBe('')
  })
})
