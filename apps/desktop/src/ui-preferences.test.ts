import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDocumentAttributes, DEFAULT_UI_PREFERENCES, normalizeUiPreferences } from './ui-preferences.ts'

describe('ui-preferences', () => {
  let mockAttributes: Record<string, string>
  let mockProperties: Record<string, string>
  const originalDocument = globalThis.document

  beforeEach(() => {
    mockAttributes = {}
    mockProperties = {}
    // 模拟 document.documentElement 避免污染全局环境
    const mockRoot = {
      setAttribute: (k: string, v: string) => { mockAttributes[k] = v },
      getAttribute: (k: string) => mockAttributes[k],
      style: {
        setProperty: (k: string, v: string) => { mockProperties[k] = v },
        getPropertyValue: (k: string) => mockProperties[k] ?? '',
      },
    }
    // @ts-expect-error test mock
    globalThis.document = { documentElement: mockRoot }
  })

  afterEach(() => {
    globalThis.document = originalDocument
  })

  it('normalizes invalid or missing preferences to defaults', () => {
    expect(normalizeUiPreferences(null)).toEqual(DEFAULT_UI_PREFERENCES)
    expect(normalizeUiPreferences({})).toEqual(DEFAULT_UI_PREFERENCES)
    expect(normalizeUiPreferences({ theme: 'invalid', background: 'not an object' })).toEqual(DEFAULT_UI_PREFERENCES)
  })

  it('preserves valid custom background image and clamps opacity/blur', () => {
    const raw = {
      theme: 'dark',
      background: {
        kind: 'image',
        value: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        blur: 100, // should clamp to 24
        opacity: -5, // should clamp to 0
      },
    }
    const normalized = normalizeUiPreferences(raw)
    expect(normalized.theme).toBe('dark')
    expect(normalized.background.kind).toBe('image')
    expect(normalized.background.blur).toBe(24)
    expect(normalized.background.opacity).toBe(0)
    expect(normalized.background.value).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
  })

  it('applies document attributes and css properties correctly for image backgrounds', () => {
    applyDocumentAttributes('dark', {
      kind: 'image',
      value: 'data:image/png;base64,test',
      blur: 8,
      opacity: 0.75,
    })

    expect(mockAttributes['data-theme']).toBe('dark')
    expect(mockAttributes['data-bg-kind']).toBe('image')
    expect(mockProperties['--user-background']).toBe('url("data:image/png;base64,test")')
    expect(mockProperties['--background-blur']).toBe('8px')
  })

  it('handles empty image value safely without generating invalid url()', () => {
    applyDocumentAttributes('dark', {
      kind: 'image',
      value: '',
      blur: 0,
      opacity: 0.85,
    })

    expect(mockProperties['--user-background']).toBe('none')
  })
})
