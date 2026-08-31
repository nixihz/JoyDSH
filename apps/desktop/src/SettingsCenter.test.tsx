import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { SettingsCenter } from './SettingsCenter.tsx'
import { DEFAULT_VOICE_INPUT_CONFIG } from './voice-input-service.ts'
import { DEFAULT_UI_PREFERENCES } from './ui-preferences.ts'

describe('SettingsCenter', () => {
  const baseProps = {
    selectedProvider: 'deepseek-official' as const,
    selectedModel: 'gpt-5.6-sol',
    credentialStatus: { configured: true, writable: true, source: 'storage' as const },
    apiKeyDraft: '',
    baseUrlDraft: '',
    showApiKey: false,
    canApplyModel: true,
    settingsBusy: false,
    onSelectProvider: vi.fn(),
    onChangeApiKeyDraft: vi.fn(),
    onToggleShowApiKey: vi.fn(),
    onChangeBaseUrlDraft: vi.fn(),
    onChangeSelectedModel: vi.fn(),
    onApplyModel: vi.fn(),
    voiceConfig: DEFAULT_VOICE_INPUT_CONFIG,
    voiceCapabilities: {
      supported: true,
      platform: 'macos',
      defaultTarget: 'right-command',
      permissionRequired: false,
      permissionGranted: true,
    },
    voicePermissionBusy: false,
    onChangeVoiceConfig: vi.fn(),
    onRequestVoicePermission: vi.fn(),
    onTestVoiceKey: vi.fn(),
    uiPreferences: DEFAULT_UI_PREFERENCES,
    appearanceColorDraft: '#1f3a52',
    appearanceGradientDraft: 'linear-gradient(135deg, #0e8fa6 0%, #2e9c4a 100%)',
    appearancePresets: [],
    appearanceBusy: false,
    onSetTheme: vi.fn(),
    onSetBackground: vi.fn(),
    onResetBackground: vi.fn(),
    onChangeColorDraft: vi.fn(),
    onChangeGradientDraft: vi.fn(),
    onPickCustomBackground: vi.fn(),
    onClose: vi.fn(),
  }

  it('渲染具有 Tab 导航栏的现代设置弹窗', () => {
    const html = renderToString(<SettingsCenter {...baseProps} />)
    expect(html).toContain('data-focus-id="settings-tab-model"')
    expect(html).toContain('data-focus-id="settings-tab-input"')
    expect(html).toContain('data-focus-id="settings-tab-appearance"')
    expect(html).toContain('data-focus-id="settings-close"')
    expect(html).toContain('系统设置')
    expect(html).toContain('偏好设置 · PREFERENCES')
  })

  it('默认或选中 model tab 时渲染模型配置表单', () => {
    const html = renderToString(<SettingsCenter {...baseProps} activeTab="model" />)
    expect(html).toContain('data-focus-id="provider-deepseek-official"')
    expect(html).toContain('data-focus-id="provider-openai"')
    expect(html).toContain('data-focus-id="api-key"')
    expect(html).toContain('data-focus-id="base-url"')
    expect(html).toContain('data-focus-id="settings-save"')
  })

  it('切换至 input tab 时渲染外设按键与语音设置', () => {
    const html = renderToString(<SettingsCenter {...baseProps} activeTab="input" />)
    expect(html).toContain('data-focus-id="voice-input-gamepad-button"')
    expect(html).toContain('data-focus-id="voice-input-key"')
    expect(html).toContain('data-focus-id="voice-input-test"')
    expect(html).toContain('语音输入与按键映射')
  })

  it('切换至 appearance tab 时渲染主题与背景设置', () => {
    const html = renderToString(<SettingsCenter {...baseProps} activeTab="appearance" />)
    expect(html).toContain('data-focus-id="appearance-theme-dark"')
    expect(html).toContain('data-focus-id="appearance-theme-light"')
    expect(html).toContain('data-focus-id="appearance-bg-none"')
    expect(html).toContain('界面外观')
  })
})
