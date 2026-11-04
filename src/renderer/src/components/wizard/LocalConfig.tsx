import type { ReactNode } from 'react'
import { REGISTRY_PRESETS, registryPresetKey } from '@shared/settings'
import { LAUNCHERS } from '@shared/local-launch'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import type { DshVersionCatalog } from '@shared/contracts'
import { useAppStore } from '../../store'
import Select from '../Select'
import type { ExternalWorkspace, WizardForm } from './types'

/** 外部 dsh 接管相关字段。 */
export interface ExternalAdoption {
  /** 探测到的全部外部 dsh（端口已确定）；一个都没有时不显示接管入口 */
  workspaces: ExternalWorkspace[]
  /** 当前选中的外部 dsh pid */
  selectedPid: number | null
  onSelect: (pid: number) => void
  useExisting: boolean
  setUseExisting: (value: boolean) => void
}

/** 版本目录与启动器探测结果（高级设置的版本/启动器下拉数据源）。 */
export interface VersionCatalogState {
  localLaunchers: Array<{ launcher: WizardForm['launcher']; version: string }>
  versionOptions: string[]
  catalog: DshVersionCatalog | null
  catalogError: string | null
  setVersionTouched: (value: boolean) => void
}

export interface LocalConfigProps {
  t: Translator
  form: WizardForm
  set: (
    key: Exclude<keyof WizardForm, 'useDefaultSpace'>
  ) => (event: { target: { value: string } }) => void
  setForm: (updater: (current: WizardForm) => WizardForm) => void
  external: ExternalAdoption
  versions: VersionCatalogState
  persistRegistry: (url: string) => void
}

/** 本机实例配置：外部 dsh 接管选项 + 高级设置（启动器/版本/配置档案/端口/空间/镜像）。 */
export default function LocalConfig(props: LocalConfigProps): ReactNode {
  const { t, form, set, setForm, external, versions, persistRegistry } = props
  const {
    workspaces: externalWorkspaces,
    selectedPid,
    onSelect: onSelectExternal,
    useExisting: useExistingExternal,
    setUseExisting: setUseExistingExternal
  } = external
  // 公共空间（默认 DSH_HOME）的本机绝对路径：Windows 为 C:\Users\<用户>\.dsh，
  // 其它平台为 /Users|home/<用户>/.dsh。向导里直接展示解析后的真实路径，避免 ~/.dsh 歧义。
  const defaultDshHome = useAppStore((state) => state.defaultDshHome)
  const {
    localLaunchers,
    versionOptions,
    catalog: versionCatalog,
    catalogError: versionCatalogError,
    setVersionTouched
  } = versions
  /** 下拉只给字符串值；写回表单时仍走同一个 setter，保持与输入框一致的行为。 */
  const setField =
    (key: Exclude<keyof WizardForm, 'useDefaultSpace'>) =>
    (value: string): void =>
      set(key)({ target: { value } })
  return (
    <>
      {externalWorkspaces.length > 0 && (
        <div className="note n-info mt12" data-testid="wizard-external-dsh">
          <Icon name="info" />
          <div>
            <b>
              {externalWorkspaces.length === 1
                ? t('wizard.externalDetected', { port: externalWorkspaces[0]?.port ?? '' })
                : t('wizard.externalDetectedMany', { n: externalWorkspaces.length })}
            </b>
            {/* 同时有多个 dsh 在跑时必须让用户选：端口各不相同，接管错一个就白填 token。 */}
            {externalWorkspaces.length > 1 && (
              <div className="field mt8">
                <label htmlFor="wizard-external-pick">{t('wizard.externalPickLabel')}</label>
                <Select
                  className="num"
                  id="wizard-external-pick"
                  value={selectedPid === null ? '' : String(selectedPid)}
                  onChange={(next) => onSelectExternal(Number(next))}
                  options={externalWorkspaces.map((item) => ({
                    value: String(item.pid),
                    label: `127.0.0.1:${item.port} · pid ${item.pid}`
                  }))}
                  testId="wizard-external-pick"
                />
              </div>
            )}
            <label className="check mt8">
              <input
                type="checkbox"
                checked={useExistingExternal}
                onChange={(event) => setUseExistingExternal(event.target.checked)}
              />
              {t('wizard.useExistingExternal')}
            </label>
            {useExistingExternal && (
              <div className="field mt8">
                <label htmlFor="wizard-external-access">{t('wizard.externalAccessLabel')}</label>
                <input
                  className="input num"
                  id="wizard-external-access"
                  type="password"
                  value={form.externalAccess}
                  onChange={set('externalAccess')}
                  autoComplete="off"
                  data-testid="wizard-external-access"
                />
                <span className="hint">{t('wizard.externalAccessHint')}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {!useExistingExternal && (
        <details className="adv mt12">
          <summary>{t('wizard.advanced')}</summary>
          <div className="grid-2 mt8">
            <div className="field">
              <label htmlFor="wizard-launcher">{t('wizard.launcherLabel')}</label>
              {/* dsh 恒为默认项（缺失时仍可选，启动会提示下载）；dush/duush 未检测到就不出现。 */}
              <Select
                id="wizard-launcher"
                value={form.launcher}
                onChange={setField('launcher')}
                options={LAUNCHERS.filter(
                  (name) => name === 'dsh' || localLaunchers.some((item) => item.launcher === name)
                ).map((name) => {
                  const detected =
                    localLaunchers.find((item) => item.launcher === name)?.version ?? null
                  return {
                    value: name,
                    label: `${name}${detected !== null ? ` · ${detected}` : ` · ${t('wizard.launcherMissing')}`}`
                  }
                })}
                testId="wizard-launcher"
              />
              {localLaunchers.length === 0 && (
                <span className="hint">{t('wizard.launcherMissingHint')}</span>
              )}
            </div>
            <div className="field">
              <label htmlFor="wizard-version">{t('wizard.versionLabel')}</label>
              <Select
                className="num"
                id="wizard-version"
                value={form.version}
                onChange={(next) => {
                  setVersionTouched(true)
                  setForm((current) => ({ ...current, version: next }))
                }}
                disabled={versionCatalog === null && versionCatalogError === null}
                options={[
                  { value: '', label: t('wizard.versionLatest') },
                  ...versionOptions.map((version) => ({ value: version, label: version }))
                ]}
                testId="wizard-version"
              />
              <span className="hint" data-testid="wizard-version-hint">
                {versionCatalogError !== null
                  ? t('wizard.versionFetchFailed', { msg: versionCatalogError })
                  : versionCatalog === null
                    ? t('wizard.versionLoading')
                    : t('wizard.versionHint')}
              </span>
            </div>
            <div className="field">
              <label htmlFor="wizard-profile">{t('wizard.profileLabel')}</label>
              <input
                className="input num"
                id="wizard-profile"
                placeholder={t('wizard.profilePlaceholder')}
                value={form.profile}
                onChange={set('profile')}
              />
            </div>
            <div className="field">
              <label htmlFor="wizard-port">{t('wizard.portLabel')}</label>
              <input
                className="input num"
                id="wizard-port"
                placeholder={t('wizard.portPlaceholder')}
                value={form.port}
                onChange={set('port')}
              />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="wizard-space">{t('wizard.spaceLabel')}</label>
              <Select
                id="wizard-space"
                value={form.useDefaultSpace ? 'shared' : 'isolated'}
                onChange={(next) =>
                  setForm((current) => ({ ...current, useDefaultSpace: next === 'shared' }))
                }
                options={[
                  { value: 'isolated', label: t('wizard.spaceIsolated') },
                  { value: 'shared', label: t('wizard.spaceShared') }
                ]}
                testId="wizard-space"
              />
              {/* 选公共空间时显示解析后的真实路径（Windows 展开为 C:\Users\<用户>\.dsh）。 */}
              {form.useDefaultSpace && defaultDshHome && (
                <span className="hint num" data-testid="wizard-space-path">
                  {t('wizard.spaceSharedPath', { path: defaultDshHome })}
                </span>
              )}
              <span className="hint">{t('wizard.spaceHint')}</span>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="wizard-registry">{t('wizard.registryLabel')}</label>
              <Select
                id="wizard-registry"
                value={registryPresetKey(form.registry)}
                onChange={(key) => {
                  if (key === 'custom') return // 仅切出输入框；当前值保持原样，由输入框失焦落盘
                  const url = key === 'system' ? '' : key
                  setForm((current) => ({ ...current, registry: url }))
                  persistRegistry(url)
                }}
                options={[
                  { value: 'system', label: t('wizard.registrySystem') },
                  ...REGISTRY_PRESETS.map((preset) => ({
                    value: preset.value,
                    label: t(preset.labelKey)
                  })),
                  { value: 'custom', label: t('wizard.registryCustom') }
                ]}
                testId="wizard-registry"
              />
              {registryPresetKey(form.registry) === 'custom' && (
                <input
                  className="input num mt4"
                  id="wizard-registry-url"
                  placeholder="https://registry.npmmirror.com"
                  value={form.registry}
                  onChange={(event) => {
                    const url = event.target.value.trim()
                    setForm((current) => ({ ...current, registry: url }))
                  }}
                  onBlur={() => persistRegistry(form.registry)}
                  data-testid="wizard-registry-url"
                />
              )}
              <span className="hint">{t('wizard.registryHint')}</span>
            </div>
          </div>
        </details>
      )}
    </>
  )
}
