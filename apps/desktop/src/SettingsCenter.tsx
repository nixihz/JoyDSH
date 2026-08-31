import { useState } from 'react'
import {
  Cpu,
  Eye,
  EyeOff,
  Gamepad2,
  KeyRound,
  Mic,
  Monitor,
  MonitorSmartphone,
  Moon,
  PaintBucket,
  Palette,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import type { CredentialStatus } from '@joydsh/dsh-adapter'
import type { KeySimulationCapabilities, VoiceInputConfig, VoiceInputGamepadButton, VoiceInputTargetKey } from './voice-input-service.ts'
import { GAMEPAD_BUTTON_OPTIONS, TARGET_KEY_OPTIONS } from './voice-input-service.ts'
import type { BackgroundConfig, PresetBackground, ThemeMode, UiPreferences } from './ui-preferences.ts'
import { UI_PREFERENCE_LIMITS } from './ui-preferences.ts'

export const PROVIDERS = {
  'deepseek-official': {
    name: 'DeepSeek',
    credentialRef: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-flash',
  },
  openai: {
    name: 'OpenAI Codex',
    credentialRef: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.6-sol',
  },
} as const

export type ModelProvider = keyof typeof PROVIDERS

export type SettingsTabId = 'model' | 'input' | 'appearance'

interface SettingsCenterProps {
  // 模型设置相关
  selectedProvider: ModelProvider
  selectedModel: string
  credentialStatus?: CredentialStatus | undefined
  apiKeyDraft: string
  baseUrlDraft: string
  showApiKey: boolean
  canApplyModel: boolean
  settingsBusy: boolean
  onSelectProvider: (provider: ModelProvider) => void
  onChangeApiKeyDraft: (value: string) => void
  onToggleShowApiKey: () => void
  onChangeBaseUrlDraft: (value: string) => void
  onChangeSelectedModel: (value: string) => void
  onApplyModel: () => void

  // 语音输入与按键相关
  voiceConfig: VoiceInputConfig
  voiceCapabilities?: KeySimulationCapabilities | undefined
  voicePermissionBusy: boolean
  voiceTestStatus?: string | undefined
  voiceGamepadConflict?: string | undefined
  onChangeVoiceConfig: (updater: (prev: VoiceInputConfig) => VoiceInputConfig) => void
  onRequestVoicePermission: () => void
  onTestVoiceKey: () => void

  // 外观设置相关
  uiPreferences: UiPreferences
  appearanceColorDraft: string
  appearanceGradientDraft: string
  appearancePresets: PresetBackground[]
  appearanceBusy: boolean
  onSetTheme: (theme: ThemeMode) => void
  onSetBackground: (updater: (current: BackgroundConfig) => BackgroundConfig) => void
  onResetBackground: () => void
  onChangeColorDraft: (color: string) => void
  onChangeGradientDraft: (gradient: string) => void
  onPickCustomBackground: () => void

  // 全局反馈与关闭
  activeTab?: SettingsTabId | undefined
  settingsError?: string | undefined
  settingsMessage?: string | undefined
  appearanceError?: string | undefined
  onClose: () => void
}

export function SettingsCenter(props: SettingsCenterProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(props.activeTab ?? 'model')
  const provider = PROVIDERS[props.selectedProvider]

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onMouseDown={event => {
        if (event.currentTarget === event.target) props.onClose()
      }}
    >
      <section className="settings-view" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header">
          <div className="settings-header__title-group">
            <span className="step-label">偏好设置 · PREFERENCES</span>
            <h2 id="settings-title">系统设置</h2>
          </div>

          <div className="settings-tabs" role="tablist" aria-label="设置类别">
            <button
              data-focus-id="settings-tab-model"
              type="button"
              role="tab"
              aria-selected={activeTab === 'model'}
              className={`settings-tab ${activeTab === 'model' ? 'settings-tab--active' : ''}`}
              onClick={() => setActiveTab('model')}
            >
              <Cpu aria-hidden="true" />
              <span>模型服务</span>
            </button>
            <button
              data-focus-id="settings-tab-input"
              type="button"
              role="tab"
              aria-selected={activeTab === 'input'}
              className={`settings-tab ${activeTab === 'input' ? 'settings-tab--active' : ''}`}
              onClick={() => setActiveTab('input')}
            >
              <Gamepad2 aria-hidden="true" />
              <span>输入与外设</span>
            </button>
            <button
              data-focus-id="settings-tab-appearance"
              type="button"
              role="tab"
              aria-selected={activeTab === 'appearance'}
              className={`settings-tab ${activeTab === 'appearance' ? 'settings-tab--active' : ''}`}
              onClick={() => setActiveTab('appearance')}
            >
              <Palette aria-hidden="true" />
              <span>外观个性化</span>
            </button>
          </div>

          <button
            data-focus-id="settings-close"
            className="icon-button icon-button--quiet"
            type="button"
            onClick={props.onClose}
            title="关闭设置"
            aria-label="关闭系统设置"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="settings-body" data-scroll-region="settings">
          {activeTab === 'model' && (
            <div className="settings-panel settings-panel--model">
              <div className="provider-segment" role="group" aria-label="模型提供方">
                {(Object.keys(PROVIDERS) as ModelProvider[]).map(id => (
                  <button
                    key={id}
                    data-focus-id={`provider-${id}`}
                    type="button"
                    className={props.selectedProvider === id ? 'provider-segment__item provider-segment__item--active' : 'provider-segment__item'}
                    aria-pressed={props.selectedProvider === id}
                    onClick={() => props.onSelectProvider(id)}
                  >
                    {PROVIDERS[id].name}
                  </button>
                ))}
              </div>

              {props.settingsBusy && props.credentialStatus === undefined ? (
                <p className="settings-loading">正在读取配置状态...</p>
              ) : props.credentialStatus !== undefined ? (
                <form className="credential-form" onSubmit={event => { event.preventDefault(); props.onApplyModel() }}>
                  <div className={props.credentialStatus.configured ? 'credential-state credential-state--ready' : 'credential-state'}>
                    <span className="state-dot" />
                    <div>
                      <strong>{props.credentialStatus.source === 'env' ? '已由启动环境配置' : props.credentialStatus.configured ? '凭据已保存' : '尚未配置凭据'}</strong>
                      <p>
                        {props.credentialStatus.source === 'env'
                          ? `JoyDSH 已检测到 ${provider.credentialRef}，密钥不会显示在界面中。`
                          : `凭据只会写入 DSH 的 ${provider.credentialRef} 存储，保存后不会回显。`}
                      </p>
                    </div>
                  </div>

                  {props.credentialStatus.writable ? (
                    <div className="model-field">
                      <label htmlFor="api-key">{provider.name} API Key</label>
                      <div className="secret-entry">
                        <input
                          data-focus-id="api-key"
                          id="api-key"
                          type={props.showApiKey ? 'text' : 'password'}
                          value={props.apiKeyDraft}
                          onChange={event => props.onChangeApiKeyDraft(event.target.value)}
                          placeholder={props.credentialStatus.configured ? '留空以保留现有 Key' : `输入 ${provider.name} API Key`}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button
                          data-focus-id="api-key-visibility"
                          className="icon-button icon-button--quiet"
                          type="button"
                          onClick={props.onToggleShowApiKey}
                          title={props.showApiKey ? '隐藏 API Key' : '显示 API Key'}
                          aria-label={props.showApiKey ? '隐藏 API Key' : '显示 API Key'}
                        >
                          {props.showApiKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="model-field">
                    <label htmlFor="base-url">Base URL</label>
                    <input
                      data-focus-id="base-url"
                      id="base-url"
                      value={props.baseUrlDraft}
                      onChange={event => props.onChangeBaseUrlDraft(event.target.value)}
                      placeholder="留空使用官方地址"
                      inputMode="url"
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p>可填写兼容服务或代理地址；清空后恢复默认地址。</p>
                  </div>

                  {props.selectedProvider === 'openai' ? (
                    <div className="model-field">
                      <label htmlFor="codex-model">Codex 模型</label>
                      <input
                        data-focus-id="codex-model"
                        id="codex-model"
                        value={props.selectedModel}
                        onChange={event => props.onChangeSelectedModel(event.target.value)}
                        placeholder="例如 gpt-5.6-sol"
                        autoCapitalize="none"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p>使用 OpenAI Platform API 计费，不消耗 ChatGPT 套餐额度。</p>
                    </div>
                  ) : null}

                  <button
                    data-focus-id="settings-save"
                    className="button button--primary button--tv settings-save"
                    type="submit"
                    disabled={props.settingsBusy || !props.canApplyModel}
                  >
                    <KeyRound aria-hidden="true" />
                    保存并使用
                  </button>
                </form>
              ) : null}
            </div>
          )}

          {activeTab === 'input' && (
            <div className="settings-panel settings-panel--input">
              <div className="settings-section__header">
                <span className="step-label">外设与输入法</span>
                <h3>语音输入与按键映射</h3>
                <p>指定手柄触发键，并通过底层按键模拟联动 Spokenly、Superwhisper 或系统听写。</p>
              </div>

              {props.voiceCapabilities?.permissionRequired === true ? (
                props.voiceCapabilities.permissionGranted === true ? (
                  <div className="voice-permission-state voice-permission-state--granted" role="status">
                    <ShieldCheck aria-hidden="true" />
                    <span>macOS 辅助功能权限已授权。</span>
                  </div>
                ) : (
                  <div className="voice-permission-state voice-permission-state--denied" role="alert">
                    <ShieldAlert aria-hidden="true" />
                    <div>
                      <strong>需要辅助功能权限</strong>
                      <p>请在“系统设置 &gt; 隐私与安全性 &gt; 辅助功能”中允许 JoyDSH，然后返回此窗口。</p>
                    </div>
                    <button
                      data-focus-id="voice-input-permission"
                      type="button"
                      className="button button--secondary"
                      disabled={props.voicePermissionBusy}
                      onClick={props.onRequestVoicePermission}
                    >
                      <ShieldCheck aria-hidden="true" />
                      {props.voicePermissionBusy ? '等待系统授权…' : '授权辅助功能'}
                    </button>
                  </div>
                )
              ) : null}

              <div className="model-field">
                <label htmlFor="voice-input-gamepad-button">手柄触发键</label>
                <select
                  data-focus-id="voice-input-gamepad-button"
                  id="voice-input-gamepad-button"
                  value={props.voiceConfig.gamepadButton}
                  onChange={event => {
                    const button = Number(event.target.value) as VoiceInputGamepadButton
                    props.onChangeVoiceConfig(prev => ({ ...prev, gamepadButton: button }))
                  }}
                >
                  {GAMEPAD_BUTTON_OPTIONS.map(option => (
                    <option key={option.index} value={option.index}>{option.label}</option>
                  ))}
                </select>
                {props.voiceGamepadConflict === undefined ? null : (
                  <p className="input-mapping-warning" role="status">
                    语音输入将替代该键原有的“{props.voiceGamepadConflict}”动作。
                  </p>
                )}
              </div>

              <div className="model-field">
                <label htmlFor="voice-input-key">听写软件触发键</label>
                <select
                  data-focus-id="voice-input-key"
                  id="voice-input-key"
                  value={props.voiceConfig.targetKey}
                  onChange={event => {
                    const key = event.target.value as VoiceInputTargetKey
                    props.onChangeVoiceConfig(prev => ({ ...prev, targetKey: key }))
                  }}
                >
                  {TARGET_KEY_OPTIONS.map(opt => (
                    <option key={opt.key} value={opt.key}>{opt.label} — {opt.description}</option>
                  ))}
                </select>
              </div>

              <div className="voice-test-actions">
                <button
                  data-focus-id="voice-input-test"
                  type="button"
                  className="button button--secondary"
                  disabled={props.voiceCapabilities?.permissionRequired === true && props.voiceCapabilities.permissionGranted !== true}
                  onClick={props.onTestVoiceKey}
                >
                  <Mic aria-hidden="true" />
                  测试模拟按键
                </button>
                {props.voiceTestStatus !== undefined ? (
                  <span className="voice-test-status">{props.voiceTestStatus}</span>
                ) : null}
              </div>
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="settings-panel settings-panel--appearance">
              <div className="settings-section__head">
                <Palette aria-hidden="true" />
                <h3>界面外观</h3>
              </div>
              <p className="settings-section__hint">主题与背景会立即生效，关闭设置时自动保存。</p>

              <div className="model-field">
                <label id="appearance-theme-label">主题模式</label>
                <div className="provider-segment" role="radiogroup" aria-labelledby="appearance-theme-label">
                  {([
                    { id: 'dark', label: '暗色', icon: Moon },
                    { id: 'light', label: '亮色', icon: MonitorSmartphone },
                    { id: 'auto', label: '跟随系统', icon: Monitor },
                  ] as { id: ThemeMode; label: string; icon: typeof Moon }[]).map(option => {
                    const Icon = option.icon
                    const isActive = props.uiPreferences.theme === option.id
                    return (
                      <button
                        key={option.id}
                        data-focus-id={`appearance-theme-${option.id}`}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        className={isActive ? 'provider-segment__item provider-segment__item--active' : 'provider-segment__item'}
                        onClick={() => props.onSetTheme(option.id)}
                      >
                        <Icon aria-hidden="true" />
                        <span>{option.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="model-field">
                <label id="appearance-bg-label">背景模式</label>
                <div className="provider-segment" role="radiogroup" aria-labelledby="appearance-bg-label">
                  {([
                    { id: 'none', label: '不使用' },
                    { id: 'color', label: '纯色' },
                    { id: 'gradient', label: '渐变' },
                    { id: 'image', label: '图片' },
                  ] as { id: BackgroundConfig['kind']; label: string }[]).map(option => {
                    const isActive = props.uiPreferences.background.kind === option.id
                    return (
                      <button
                        key={option.id}
                        data-focus-id={`appearance-bg-${option.id}`}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        className={isActive ? 'provider-segment__item provider-segment__item--active' : 'provider-segment__item'}
                        onClick={() => {
                          if (option.id === 'none') {
                            props.onResetBackground()
                          } else if (option.id === 'color') {
                            props.onSetBackground(current => ({
                              ...current,
                              kind: 'color',
                              value: current.value && current.value.startsWith('#') ? current.value : props.appearanceColorDraft,
                            }))
                          } else if (option.id === 'gradient') {
                            props.onSetBackground(current => ({
                              ...current,
                              kind: 'gradient',
                              value: current.value && current.value.includes('gradient') ? current.value : props.appearanceGradientDraft,
                            }))
                          } else if (option.id === 'image') {
                            props.onSetBackground(current => {
                              let imageValue = current.value
                              if (!imageValue && props.appearancePresets.length > 0) {
                                imageValue = props.appearancePresets[0]?.dataUrl ?? ''
                              }
                              return { ...current, kind: 'image', value: imageValue }
                            })
                          }
                        }}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {props.uiPreferences.background.kind === 'color' ? (
                <div className="model-field">
                  <label htmlFor="appearance-color">纯色值</label>
                  <div className="color-picker-row">
                    <input
                      data-focus-id="appearance-color"
                      id="appearance-color"
                      type="color"
                      value={props.uiPreferences.background.value && /^#[0-9a-fA-F]{6}$/.test(props.uiPreferences.background.value) ? props.uiPreferences.background.value : props.appearanceColorDraft}
                      onChange={event => {
                        props.onChangeColorDraft(event.target.value)
                        props.onSetBackground(current => ({ ...current, kind: 'color', value: event.target.value }))
                      }}
                    />
                    <input
                      type="text"
                      value={props.uiPreferences.background.value}
                      onChange={event => props.onSetBackground(current => ({ ...current, kind: 'color', value: event.target.value }))}
                      placeholder="#1f3a52"
                      spellCheck={false}
                      aria-label="颜色 hex 值"
                    />
                  </div>
                </div>
              ) : null}

              {props.uiPreferences.background.kind === 'gradient' ? (
                <div className="model-field">
                  <label htmlFor="appearance-gradient">CSS 渐变表达式</label>
                  <textarea
                    data-focus-id="appearance-gradient"
                    id="appearance-gradient"
                    value={props.uiPreferences.background.value}
                    onChange={event => {
                      props.onChangeGradientDraft(event.target.value)
                      props.onSetBackground(current => ({ ...current, kind: 'gradient', value: event.target.value }))
                    }}
                    rows={3}
                    spellCheck={false}
                  />
                  <p>支持任意合法的 CSS background-image，例如：linear-gradient(135deg, #0e8fa6 0%, #2e9c4a 100%)。</p>
                </div>
              ) : null}

              {props.uiPreferences.background.kind === 'image' ? (
                <div className="model-field">
                  <label>预设壁纸</label>
                  {props.appearancePresets.length === 0 ? (
                    <p className="settings-section__hint">当前没有可用的预设图，可点击下方按钮上传自定义图片。</p>
                  ) : (
                    <div className="preset-grid">
                      {props.appearancePresets.map(preset => (
                        <button
                          key={preset.id}
                          data-focus-id={`appearance-preset-${preset.id}`}
                          type="button"
                          className={props.uiPreferences.background.value === preset.dataUrl ? 'preset-card preset-card--active' : 'preset-card'}
                          onClick={() => props.onSetBackground(current => ({ ...current, kind: 'image', value: preset.dataUrl }))}
                          title={`${preset.label}（${(preset.bytes / 1024).toFixed(0)} KB）`}
                        >
                          <img src={preset.dataUrl} alt={preset.label} />
                          <span>{preset.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="preset-actions">
                    <button
                      data-focus-id="appearance-upload"
                      type="button"
                      className="button button--secondary"
                      onClick={props.onPickCustomBackground}
                      disabled={props.appearanceBusy}
                    >
                      <PaintBucket aria-hidden="true" />
                      <span>{props.appearanceBusy ? '处理中…' : '上传自定义图片'}</span>
                    </button>
                    {props.uiPreferences.background.kind === 'image' && props.uiPreferences.background.value !== '' ? (
                      <button
                        data-focus-id="appearance-clear-image"
                        type="button"
                        className="icon-button icon-button--quiet"
                        onClick={() => props.onSetBackground(current => ({ ...current, value: '' }))}
                        title="清除图片"
                        aria-label="清除当前图片"
                      >
                        <X aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {props.uiPreferences.background.kind !== 'none' ? (
                <>
                  <div className="model-field">
                    <label htmlFor="appearance-opacity">蒙版不透明度</label>
                    <input
                      data-focus-id="appearance-opacity"
                      id="appearance-opacity"
                      type="range"
                      min={UI_PREFERENCE_LIMITS.minOpacity}
                      max={UI_PREFERENCE_LIMITS.maxOpacity}
                      step={0.05}
                      value={props.uiPreferences.background.opacity}
                      onChange={event => {
                        const opacity = Number(event.target.value)
                        props.onSetBackground(current => ({ ...current, opacity }))
                      }}
                    />
                    <p>{Math.round(props.uiPreferences.background.opacity * 100)}% — 数值越小背景越显眼。</p>
                  </div>

                  <div className="model-field">
                    <label htmlFor="appearance-blur">毛玻璃模糊度</label>
                    <input
                      data-focus-id="appearance-blur"
                      id="appearance-blur"
                      type="range"
                      min={UI_PREFERENCE_LIMITS.minBlur}
                      max={UI_PREFERENCE_LIMITS.maxBlur}
                      step={1}
                      value={props.uiPreferences.background.blur}
                      onChange={event => {
                        const blur = Number(event.target.value)
                        props.onSetBackground(current => ({ ...current, blur }))
                      }}
                    />
                    <p>{props.uiPreferences.background.blur}px — 建议 4~10px 平衡美观与可读性。</p>
                  </div>
                </>
              ) : null}
            </div>
          )}

          {props.appearanceError === undefined ? null : <div className="inline-error" role="alert">{props.appearanceError}</div>}
          {props.settingsError === undefined ? null : <div className="inline-error" role="alert">{props.settingsError}</div>}
          {props.settingsMessage === undefined ? null : <div className="inline-success" role="status">{props.settingsMessage}</div>}
        </div>
      </section>
    </div>
  )
}
