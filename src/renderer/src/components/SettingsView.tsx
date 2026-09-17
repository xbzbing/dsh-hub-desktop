import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { VaultStatusSnapshot } from '@shared/contracts'
import { LANGUAGES, THEMES } from '@shared/settings'
import type { Language, Theme } from '@shared/settings'
import { Icon } from '../lib/icons'
import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/**
 * 设置页：语言、主题、原生偏好、数据目录和凭据存储。
 * 设置更改在持久化成功后显示确认。
 */
export default function SettingsView(): ReactNode {
  const t = useAppStore((state) => state.t)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const toast = useAppStore((state) => state.toast)
  const userDataPath = useAppStore((state) => state.userDataPath)
  const [vault, setVault] = useState<VaultStatusSnapshot | null>(null)

  useEffect(() => {
    void BRIDGE?.vault.status().then((result) => {
      if (result.ok) setVault(result.value)
    })
  }, [])

  const apply = (patch: Parameters<typeof updateSettings>[0]): void => {
    // 仅在设置持久化成功后显示确认。
    void updateSettings(patch).then(
      () => toast('ok', t('settings.saved')),
      (error: unknown) => toast('err', t('settings.saveFailed'), String(error))
    )
  }

  const clearVault = (): void => {
    void BRIDGE?.vault.clear().then((result) => {
      if (result.ok) {
        setVault(result.value)
        toast('ok', t('settings.cleared'))
      }
    })
  }

  /**
   * 主进程自行解析数据目录，渲染层不传路径，避免将通道用于打开任意文件。
   */
  const openDataDir = (): void => {
    void BRIDGE?.settings.openDataDir().then((result) => {
      if (result && !result.ok) toast('err', t('settings.openDataDirFailed'), result.message)
    })
  }

  return (
    <section data-testid="view-settings">
      <h2 className="h2">{t('settings.title')}</h2>

      <div className="card mt12">
        <div className="card-head">
          <h3>{t('settings.language')}</h3>
          <span className="meta">{t('settings.languageHint')}</span>
        </div>
        <div className="row mt12" style={{ gap: 8 }}>
          {LANGUAGES.map((language: Language) => (
            <button
              key={language}
              className={`btn btn-sm ${settings.language === language ? 'btn-primary' : 'btn-secondary'}`}
              data-testid={`settings-language-${language}`}
              onClick={() => apply({ language })}
            >
              {language === 'zh' ? '中文' : 'English'}
            </button>
          ))}
        </div>

        <div className="card-head mt12">
          <h3>{t('settings.theme')}</h3>
        </div>
        <div className="row mt12" style={{ gap: 8 }}>
          {THEMES.map((theme: Theme) => (
            <button
              key={theme}
              className={`btn btn-sm ${settings.theme === theme ? 'btn-primary' : 'btn-secondary'}`}
              data-testid={`settings-theme-${theme}`}
              onClick={() => apply({ theme })}
            >
              {theme === 'system'
                ? t('settings.themeSystem')
                : theme === 'light'
                  ? t('settings.themeLight')
                  : t('settings.themeDark')}
            </button>
          ))}
        </div>
      </div>

      <div className="card mt12">
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            data-testid="settings-tray"
            checked={settings.tray}
            onChange={(event) => apply({ tray: event.target.checked })}
          />
          <span>{t('settings.tray')}</span>
        </label>
        <label className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            data-testid="settings-autostart"
            checked={settings.autoStart}
            onChange={(event) => apply({ autoStart: event.target.checked })}
          />
          <span>{t('settings.autoStart')}</span>
        </label>
        <label className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>
            <span>{t('settings.workspaceCache')}</span>
            <span className="meta" style={{ display: 'block', marginTop: 2 }}>
              {t('settings.workspaceCacheHint')}
            </span>
          </span>
          <input
            className="input"
            type="number"
            min={1}
            max={10}
            step={1}
            value={settings.workspaceCacheSize}
            aria-label={t('settings.workspaceCache')}
            data-testid="settings-workspace-cache-size"
            onChange={(event) => {
              const value = Number(event.target.value)
              if (Number.isInteger(value) && value >= 1 && value <= 10) apply({ workspaceCacheSize: value })
            }}
            style={{ width: 70 }}
          />
        </label>
      </div>

      <div className="card mt12">
        <div className="card-head">
          <h3>{t('settings.dataDir')}</h3>
        </div>
        {/* 设计稿 data-act="open-dir":展示路径 + 「打开」按钮(与行内其它按钮同规格) */}
        <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
          {/* 路径可能很长:允许在任意位置换行,不把「打开」按钮挤出卡片 */}
          <span
            className="meta num"
            style={{ minWidth: 0, overflowWrap: 'anywhere' }}
            data-testid="settings-data-dir"
          >
            {userDataPath ?? '—'}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            data-act="open-dir"
            data-testid="settings-open-data-dir"
            onClick={openDataDir}
          >
            {t('settings.openDataDir')}
          </button>
        </div>
      </div>

      <div className="card mt12" data-testid="settings-vault">
        <div className="card-head">
          <h3>{t('vault.title')}</h3>
          <span className="meta">
            {vault?.degraded ? t('vault.backendMemory') : t('vault.backendKeychain')}
          </span>
        </div>
        {vault?.degraded && (
          <div className="note n-warn mt12">
            <Icon name="alert" />
            <span>{t('vault.degraded')}</span>
          </div>
        )}
        <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
          <button
            className="btn btn-secondary btn-sm"
            data-testid="settings-clear-vault"
            onClick={clearVault}
          >
            <Icon name="trash" /> {t('settings.clearCredentials')}
          </button>
          <span className="meta">
            {vault && vault.rememberedInstances.length > 0
              ? t('vault.remembered')
              : t('vault.notRemembered')}
          </span>
        </div>
      </div>
    </section>
  )
}
