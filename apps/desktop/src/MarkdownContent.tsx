import { useState, useCallback, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, AlertCircle } from 'lucide-react'
import type { LightboxImage } from './ImageLightbox.tsx'

interface CodeBlockProps {
  language?: string | undefined
  value: string
}

function CodeBlock({ language, value }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback or ignore clipboard error
    }
  }, [value])

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-block__header">
        <span className="markdown-code-block__lang">{language || 'text'}</span>
        <button
          type="button"
          className="markdown-code-block__copy"
          onClick={handleCopy}
          aria-label="复制代码"
          title="复制代码"
        >
          {copied ? (
            <>
              <Check className="markdown-code-block__copy-icon" aria-hidden="true" />
              <span>已复制</span>
            </>
          ) : (
            <>
              <Copy className="markdown-code-block__copy-icon" aria-hidden="true" />
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      <pre className="markdown-code-block__pre">
        <code>{value}</code>
      </pre>
    </div>
  )
}

interface MarkdownImageProps {
  src?: string | undefined
  alt?: string | undefined
  onPreview?: ((image: LightboxImage) => void) | undefined
}

function MarkdownImage({ src, alt, onPreview }: MarkdownImageProps) {
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)

  if (!src) return null

  if (error) {
    return (
      <span className="markdown-image-error" title={`无法加载图片: ${src}`}>
        <AlertCircle className="markdown-image-error-icon" aria-hidden="true" />
        <span>[图片加载失败: {alt || src}]</span>
      </span>
    )
  }

  return (
    <span className={`markdown-image-wrapper ${loaded ? 'markdown-image-wrapper--loaded' : 'markdown-image-wrapper--loading'}`}>
      <img
        src={src}
        alt={alt || ''}
        className="markdown-image"
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        onClick={() => {
          if (onPreview) {
            onPreview({ src, alt, title: alt })
          }
        }}
        style={{ cursor: onPreview ? 'zoom-in' : 'default' }}
      />
    </span>
  )
}

export interface MarkdownContentProps {
  content: string
  className?: string
  onPreviewImage?: (image: LightboxImage) => void
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  className = '',
  onPreviewImage,
}: MarkdownContentProps) {
  return (
    <div className={`markdown-body ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className: codeClassName, children, ...props }) {
            const match = /language-(\w+)/.exec(codeClassName || '')
            const isCodeBlock = match !== null || (typeof children === 'string' && children.includes('\n'))

            if (isCodeBlock) {
              const codeString = String(children).replace(/\n$/, '')
              return <CodeBlock language={match?.[1]} value={codeString} />
            }

            return (
              <code className="markdown-inline-code" {...props}>
                {children}
              </code>
            )
          },
          pre({ children }) {
            // Unwrap pre because CodeBlock provides its own container
            return <>{children}</>
          },
          img({ src, alt }) {
            return <MarkdownImage src={src} alt={alt} onPreview={onPreviewImage} />
          },
          a({ href, children, ...props }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="markdown-link"
                {...props}
              >
                {children}
              </a>
            )
          },
          table({ children, ...props }) {
            return (
              <div className="markdown-table-wrapper">
                <table className="markdown-table" {...props}>
                  {children}
                </table>
              </div>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
