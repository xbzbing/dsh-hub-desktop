import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CreateInstanceInput, DshVersionCatalog } from '@shared/contracts'
import { tryParseEndpoint } from '@shared/endpoint'
import { REGISTRY_PRESETS } from '@shared/settings'
import { LAUNCHERS, type LocalLauncher } from '@shared/local-launch'
import { Icon } from '../lib/icons'
import { buildVersionOptions } from '../lib/version-options'
import KeyPreview from './KeyPreview'
import UrlDetect from './UrlDetect'
import { TYPE_INFO } from '../lib/format'
import { useAppStore } from '../store'
import { Modal } from './Modal'
import type { MessageKey } from '@shared/i18n/messages'

const STEP_KEYS: MessageKey[] = ['wizard.stepTransport', 'wizard.stepConfig', 'wizard.stepConfirm']

interface WizardForm {
  name: string
  version: string
  profile: string
  port: string
  launcher: LocalLauncher
  useDefaultSpace: boolean
  registry: string
  host: string
  username: string
  sshPort: string
  remotePort: string
  endpointUrl: string
  externalAccess: string
}

const EMPTY_FORM: WizardForm = {
  name: '',
  version: '',
  profile: '',
  port: '',
  launcher: 'dsh',
  useDefaultSpace: false,
  registry: '',
  host: '',
  username: '',
  sshPort: '22',
  remotePort: '3080',
  endpointUrl: '',
  externalAccess: ''
}

/** 将注册表值映射到下拉选项：'' 为跟随系统，预设 URL 为对应选项，其余为自定义。 */
function registryOptionKey(url: string): string {
  if (url === '') return 'system'
  return REGISTRY_PRESETS.some((preset) => preset.value === url) ? url : 'custom'
}

/**
 * 直连 HTTP 使用明文数据连接，需要在保存前显示警告。
 * 共享端点解析会将省略协议的地址视为 HTTP；HTTPS 和解析失败时不显示警告。
 */
function isCleartextEndpoint(endpointUrl: string): boolean {
  const parsed = tryParseEndpoint(endpointUrl)
  return parsed.ok && parsed.endpoint.scheme === 'http'
}

/** 创建向导：选择类型、填写表单并确认创建；本地实例创建后自动启动并打开窗口。 */
export default function Wizard(): ReactNode {
  const t = useAppStore((state) => state.t)
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  const refreshList = useAppStore((state) => state.refreshList)
  const instances = useAppStore((state) => state.instances)
  const openWorkspace = useAppStore((state) => state.openWorkspace)
  const select = useAppStore((state) => state.select)
  const setPendingOpen = useAppStore((state) => state.setPendingOpen)
  const toast = useAppStore((state) => state.toast)
  const existingSpaceId = useAppStore((state) => state.wizardExistingSpaceId)

  const [step, setStep] = useState(1)
  const [transport, setTransport] = useState<'local' | 'ssh' | 'http'>('local')
  const [form, setForm] = useState<WizardForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [localLaunchers, setLocalLaunchers] = useState<Array<{ launcher: LocalLauncher; version: string }>>([])
  const [externalWorkspace, setExternalWorkspace] = useState<{
    pid: number
    port: number
    patch: string | null
  } | null>(null)
  const [useExistingExternal, setUseExistingExternal] = useState(false)
  const [localProbeDone, setLocalProbeDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  /** 版本下拉数据源；null = 尚未取到。 */
  const [versionCatalog, setVersionCatalog] = useState<DshVersionCatalog | null>(null)
  /** 版本列表获取失败原因；非 null 时在下拉下方提示。 */
  const [versionCatalogError, setVersionCatalogError] = useState<string | null>(null)
  /** 用户是否手动选过版本；选过则本地版本不再覆盖默认值。 */
  const [versionTouched, setVersionTouched] = useState(false)
  /** 自增触发版本目录重取（切换安装镜像后按新源刷新）。 */
  const [catalogEpoch, setCatalogEpoch] = useState(0)

  // Escape 关闭由 Modal 的窗口级关闭栈统一处理（只关最上层），此处不再单独监听。

  useEffect(() => {
    if (step !== 2 || transport !== 'local' || localProbeDone) return
    let cancelled = false
    void Promise.all([window.dshHub?.runtime.probeLocalDsh(), window.dshHub?.runtime.scanExternal()]).then(
      ([runtime, external]) => {
        if (!cancelled) {
          setLocalLaunchers(runtime?.ok ? runtime.value : [])
          setExternalWorkspace(
            external?.ok
              ? (external.value.find((item) => item.port !== null) as {
                  pid: number
                  port: number
                  patch: string | null
                } | undefined) ?? null
              : null
          )
          setLocalProbeDone(true)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [step, transport, localProbeDone])

  // 本地实例：向导一打开就预取版本目录（走到第 2 步时通常已就绪）；切换安装镜像后按新源重取。
  useEffect(() => {
    if (transport !== 'local') return
    let cancelled = false
    setVersionCatalogError(null)
    void window.dshHub?.runtime.listDshVersions().then((result) => {
      if (cancelled) return
      if (result?.ok) setVersionCatalog(result.value)
      else setVersionCatalogError(result?.message ?? t('common.unknown'))
    })
    return () => {
      cancelled = true
    }
  }, [transport, catalogEpoch, t])

  // 版本默认与本地版本相同：本机探测到的 dsh 优先，其次 hub 已安装的最新；用户改过不覆盖。
  useEffect(() => {
    if (versionTouched || form.version !== '') return
    const preset =
      localLaunchers.find((item) => item.launcher === 'dsh')?.version ?? versionCatalog?.installed[0]
    if (preset) {
      setForm((current) => (current.version === '' ? { ...current, version: preset } : current))
    }
  }, [versionTouched, form.version, localLaunchers, versionCatalog])

  // 加载当前设置以初始化安装镜像默认值
  useEffect(() => {
    if (settingsLoaded) return
    void window.dshHub?.settings.get().then((result) => {
      if (result.ok && !settingsLoaded) {
        setForm((current) => ({
          ...current,
          registry: current.registry === '' ? (result.value.npmRegistry ?? '') : current.registry
        }))
        setSettingsLoaded(true)
      }
    })
  }, [settingsLoaded])

  /** 镜像选择落盘；写失败以 toast 提示，避免用户以为已生效。成功后按新源重取版本列表。 */
  const persistRegistry = (url: string): void => {
    void window.dshHub?.settings.update({ npmRegistry: url }).then((result) => {
      if (!result.ok) toast('err', t('settings.saveFailed'), result.message)
      else setCatalogEpoch((epoch) => epoch + 1)
    })
  }


  const set = (key: Exclude<keyof WizardForm, 'useDefaultSpace'>) => (event: { target: { value: string } }) => {
    const value = event.target.value
    setForm((current) => ({ ...current, [key]: value }))
    if (key === 'name' && value.trim() !== '') setError(null)
  }

  const reusableExternalInstance =
    transport === 'local' && useExistingExternal && externalWorkspace
      ? instances.find(
          (instance) => instance.transport === 'local' && instance.address === `127.0.0.1:${externalWorkspace.port}`
        )
      : undefined
  const configuredName = reusableExternalInstance?.name ?? form.name

  // 版本下拉：registry 最近 10 个（从新到旧、最新在上）；本地版本/当前选中值不在其中时补在末尾。
  const localDshVersion = localLaunchers.find((item) => item.launcher === 'dsh')?.version
  const versionOptions = buildVersionOptions(
    versionCatalog?.versions ?? [],
    localDshVersion,
    form.version
  )

  const formError = (): string | null => {
    if (!form.name.trim() && !reusableExternalInstance) return t('wizard.errName')
    if (
      transport === 'local' &&
      useExistingExternal &&
      !reusableExternalInstance &&
      !form.externalAccess.trim()
    ) {
      return t('wizard.errExternalAccess')
    }
    if (
      transport === 'local' &&
      !useExistingExternal &&
      form.profile.trim() !== '' &&
      (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(form.profile.trim()) || form.profile.trim().split('/').includes('..'))
    ) {
      return t('wizard.errProfile')
    }
    if (transport === 'ssh') {
      if (!form.host.trim()) return t('wizard.errHost')
      if (!form.username.trim()) return t('wizard.errUsername')
    }
    if (transport === 'http') {
      const parsed = tryParseEndpoint(form.endpointUrl)
      if (!parsed.ok) return parsed.message
    }
    return null
  }

  const create = async (): Promise<void> => {
    const bridge = window.dshHub
    if (!bridge) return
    const name = form.name.trim()
    const existingExternalInstance = reusableExternalInstance
    if (existingExternalInstance) {
      setBusy(true)
      setError(null)
      try {
        if (!externalWorkspace) {
          setError(t('wizard.errExternalAccess'))
          return
        }
        const adopted = await bridge.runtime.adoptExternal(
          existingExternalInstance.id,
          externalWorkspace.pid,
          form.externalAccess.trim()
        )
        if (!adopted.ok) {
          setError(adopted.message)
          return
        }
        setWizardOpen(false)
        void openWorkspace(existingExternalInstance.id)
        return
      } finally {
        setBusy(false)
      }
    }
    const problem = formError()
    if (problem) {
      setError(problem)
      setStep(2)
      return
    }
    const input: CreateInstanceInput =
      transport === 'local'
        ? {
            transport: 'local',
            name,
            ...(useExistingExternal
              ? {
                  useExistingExternal: true,
                  externalPid: externalWorkspace?.pid,
                  externalAccess: form.externalAccess.trim()
                }
              : {}),
            ...(form.version.trim() !== '' ? { dshVersion: form.version.trim() } : {}),
            ...(form.profile.trim() !== '' ? { profile: form.profile.trim() } : {}),
            ...(form.port.trim() !== '' ? { port: Number(form.port) } : {}),
            ...(form.launcher !== 'dsh' ? { launcher: form.launcher } : {}),
            ...(form.useDefaultSpace ? { useDefaultSpace: true } : {}),
            ...(existingSpaceId ? { existingSpaceId } : {})
          }
        : transport === 'ssh'
          ? {
              transport: 'ssh',
              name,
              host: form.host.trim(),
              username: form.username.trim(),
              ...(form.sshPort !== '22' ? { port: Number(form.sshPort) } : {}),
              ...(form.remotePort !== '3080' ? { remotePort: Number(form.remotePort) } : {})
            }
          : {
              transport: 'http',
              name,
              endpointUrl: form.endpointUrl.trim()
            }

    setBusy(true)
    setError(null)
    const result = await bridge.instances.create(input).finally(() => setBusy(false))
    if (!result.ok) {
      setError(result.message)
      setStep(2)
      return
    }
    setWizardOpen(false)
    toast('ok', t('wizard.created', { name: result.value.name }))
    void refreshList()
    // 创建后无论启动成功与否都先落到详情；失败时用户可立即编辑端口、配置档案或启动器。
    select(result.value.id)
    if (transport === 'local' && useExistingExternal) {
      void openWorkspace(result.value.id)
      return
    }
    // 启动成功后由状态事件打开工作区；失败或停止时移除待打开记录。
    setPendingOpen(result.value.id)
    const started = await bridge.runtime.start(result.value.id)
    if (!started.ok) {
      toast('err', t('wizard.startFailed'), started.message)
      // 失败事件会在 applyStatus 里把该 id 移出待开集合
    }
  }

  return (
    <Modal
      closeLabel={t('common.close')}
      wide
      title={t('wizard.title')}
      sub={t('wizard.sub')}
      onClose={() => setWizardOpen(false)}
      testId="wizard"
      footer={
        <>
          <span className="modal-foot-copy meta">
            {step === 2 && t('wizard.nextShortcut')}
            {error && <span className="err">{error}</span>}
          </span>
          <div className="right">
            {step > 1 && (
              <button className="btn btn-secondary" onClick={() => setStep(step - 1)} disabled={busy}>
               {t('wizard.prev')}
              </button>
            )}
            {step < 3 ? (
              <button
                className="btn btn-primary"
                onClick={() => {
                  // 仅在填写配置和创建前校验表单。
                  if (step === 1) {
                    setError(null)
                    setStep(2)
                    return
                  }
                  const problem = formError()
                  if (problem) setError(problem)
                  else setStep(step + 1)
                }}
                disabled={busy}
              >
               {t('wizard.next')}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => void create()}
                disabled={busy}
                data-testid="wizard-create"
              >
                {busy ? t('wizard.creating') : t('wizard.create')}
              </button>
            )}
          </div>
        </>
      }
    >
      <div className="stepper">
        {STEP_KEYS.map((labelKey, index) => {
          const n = index + 1
          const cls = n === step ? 'on' : n < step ? 'done' : ''
          return (
            <div key={labelKey} style={{ display: 'contents' }}>
              <span className={`step ${cls}`}>
                <b>{n}</b>
                {t(labelKey)}
              </span>
              {n < 3 && <span className="step-line" />}
            </div>
          )
        })}
      </div>

      {step === 1 && (
        <div className="type-cards" data-testid="wizard-step-1">
          <TypeCard
            transport="local"
            pressed={transport === 'local'}
            onClick={() => setTransport('local')}
          />
          <TypeCard
            transport="ssh"
            pressed={transport === 'ssh'}
            onClick={() => setTransport('ssh')}
          />
          <TypeCard
            transport="http"
            pressed={transport === 'http'}
            onClick={() => setTransport('http')}
          />
        </div>
      )}

      {step === 2 && (
        <div data-testid="wizard-step-2">
          <div className="field">
            <label htmlFor="wizard-name">{t('wizard.nameLabel')}</label>
            <input
              className="input"
              id="wizard-name"
              placeholder={t('wizard.namePlaceholder')}
              value={configuredName}
              onChange={set('name')}
              disabled={reusableExternalInstance !== undefined}
              data-testid="wizard-name"
            />
            <span className="hint">{t('wizard.nameHint')}</span>
          </div>

          {transport === 'local' && (
            <>
              {externalWorkspace && (
                <div className="note n-info mt12" data-testid="wizard-external-dsh">
                  <Icon name="info" />
                  <div>
                    <b>{t('wizard.externalDetected', { port: externalWorkspace.port })}</b>
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
                      <select
                        className="input"
                        id="wizard-launcher"
                        value={form.launcher}
                        onChange={set('launcher')}
                        data-testid="wizard-launcher"
                      >
                        {/* dsh 恒为默认项（缺失时仍可选，启动会提示下载）；dush/duush 未检测到就不出现。 */}
                        {LAUNCHERS.filter(
                          (name) =>
                            name === 'dsh' ||
                            localLaunchers.some((item) => item.launcher === name)
                        ).map((name) => {
                          const detected =
                            localLaunchers.find((item) => item.launcher === name)?.version ?? null
                          return (
                            <option key={name} value={name}>
                              {name}
                              {detected !== null
                                ? ` · ${detected}`
                                : ` · ${t('wizard.launcherMissing')}`}
                            </option>
                          )
                        })}
                      </select>
                      {localLaunchers.length === 0 && <span className="hint">{t('wizard.launcherMissingHint')}</span>}
                    </div>
                    <div className="field">
                      <label htmlFor="wizard-version">{t('wizard.versionLabel')}</label>
                      <select
                        className="input num"
                        id="wizard-version"
                        value={form.version}
                        onChange={(event) => {
                          setVersionTouched(true)
                          setForm((current) => ({ ...current, version: event.target.value }))
                        }}
                        disabled={versionCatalog === null && versionCatalogError === null}
                        data-testid="wizard-version"
                      >
                        <option value="">{t('wizard.versionLatest')}</option>
                        {versionOptions.map((version) => (
                          <option key={version} value={version}>
                            {version}
                          </option>
                        ))}
                      </select>
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
                      <select
                        className="input"
                        id="wizard-space"
                        value={form.useDefaultSpace ? 'shared' : 'isolated'}
                        onChange={(event) =>
                          setForm((current) => ({ ...current, useDefaultSpace: event.target.value === 'shared' }))
                        }
                        data-testid="wizard-space"
                      >
                        <option value="isolated">{t('wizard.spaceIsolated')}</option>
                        <option value="shared">{t('wizard.spaceShared')}</option>
                      </select>
                      <span className="hint">{t('wizard.spaceHint')}</span>
                    </div>
                    <div className="field" style={{ gridColumn: '1 / -1' }}>
                      <label htmlFor="wizard-registry">{t('wizard.registryLabel')}</label>
                      <select
                        className="input"
                        id="wizard-registry"
                        value={registryOptionKey(form.registry)}
                        onChange={(event) => {
                          const key = event.target.value
                          if (key === 'custom') return // 仅切出输入框；当前值保持原样，由输入框失焦落盘
                          const url = key === 'system' ? '' : key
                          setForm((current) => ({ ...current, registry: url }))
                          persistRegistry(url)
                        }}
                        data-testid="wizard-registry"
                      >
                        <option value="system">{t('wizard.registrySystem')}</option>
                        {REGISTRY_PRESETS.map((preset) => (
                          <option key={preset.value} value={preset.value}>
                            {t(preset.labelKey)}
                          </option>
                        ))}
                        <option value="custom">{t('wizard.registryCustom')}</option>
                      </select>
                      {registryOptionKey(form.registry) === 'custom' && (
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
          )}

          {transport === 'ssh' && (
            <>
              <div className="grid-2 mt12">
                <div className="field">
                  <label htmlFor="wizard-host">{t('wizard.hostLabel')}</label>
                  <input
                    className="input"
                    id="wizard-host"
                    placeholder={t('wizard.hostPlaceholder')}
                    value={form.host}
                    onChange={set('host')}
                    data-testid="wizard-host"
                  />
                </div>
                <div className="field">
                  <label htmlFor="wizard-user">{t('wizard.userLabel')}</label>
                  <input
                    className="input"
                    id="wizard-user"
                    placeholder={t('wizard.userPlaceholder')}
                    value={form.username}
                    onChange={set('username')}
                    data-testid="wizard-user"
                  />
                </div>
                <div className="field">
                  <label htmlFor="wizard-ssh-port">{t('wizard.sshPortLabel')}</label>
                  <input
                    className="input num"
                    id="wizard-ssh-port"
                    value={form.sshPort}
                    onChange={set('sshPort')}
                  />
                </div>
                <div className="field">
                  <label htmlFor="wizard-remote-port">{t('wizard.remotePortLabel')}</label>
                  <input
                    className="input num"
                    id="wizard-remote-port"
                    value={form.remotePort}
                    onChange={set('remotePort')}
                  />
                </div>
              </div>
              <div className="mt12">
                <KeyPreview host={form.host} username={form.username} sshPort={form.sshPort} />
              </div>
              <div className="hintbar mt12">
                <Icon name="info" />
                <span>
                  {t('wizard.sshAgentHint')}
                </span>
              </div>
            </>
          )}

          {transport === 'http' && (
            <>
              <div className="field mt12">
                <label htmlFor="wizard-url">{t('wizard.urlLabel')}</label>
                <input
                  className="input num"
                  id="wizard-url"
                  placeholder="https://host:8443"
                  value={form.endpointUrl}
                  onChange={set('endpointUrl')}
                  data-testid="wizard-url"
                />
                <span className="hint">{t('wizard.urlHint')}</span>
              </div>
              {/* 直连 HTTP 使用明文数据连接，创建前显示警告。 */}
              {isCleartextEndpoint(form.endpointUrl) && (
                <div className="note n-warn mt12" data-testid="wizard-cleartext-warning">
                  <Icon name="alert" />
                  <span>{t('wizard.cleartextWarning')}</span>
                </div>
              )}
              <div className="mt12">
                <UrlDetect endpointUrl={form.endpointUrl} />
              </div>
            </>
          )}
        </div>
      )}

      {step === 3 && (
        <div data-testid="wizard-step-3">
          <p className="meta">{t('wizard.confirmHint')}</p>
          <div className="inset mt12">
            <dl className="kv">
              <dt>{t('wizard.dtName')}</dt>
              <dd>{configuredName}</dd>
              <dt>{t('wizard.dtTransport')}</dt>
              <dd>
                {transport === 'local' && useExistingExternal
                  ? t('wizard.currentWorkspace')
                  : t(TYPE_INFO[transport].labelKey)}
                {transport === 'ssh' && form.username ? ` · ${form.username}@${form.host}` : ''}
              </dd>
              <dt>{t('wizard.dtAddress')}</dt>
              <dd className="num">
                {transport === 'local'
                  ? useExistingExternal && externalWorkspace
                    ? `127.0.0.1:${externalWorkspace.port}`
                    : t('wizard.autoPort')
                  : transport === 'ssh'
                    ? `${form.host}:${form.remotePort}`
                    : form.endpointUrl}
              </dd>
              {transport === 'local' && useExistingExternal && externalWorkspace && (
                <>
                  <dt>PID</dt>
                  <dd className="num">{externalWorkspace.pid}</dd>
                  <dt>{t('detail.externalPatch')}</dt>
                  <dd className="num">
                    {externalWorkspace.patch
                      ? t('wizard.externalPatch', { patch: externalWorkspace.patch })
                      : t('wizard.externalNoPatch')}
                  </dd>
                </>
              )}
            </dl>
          </div>
          <div className="note n-info mt12">
            <Icon
              name={
                transport === 'local'
                  ? useExistingExternal
                    ? 'info'
                    : 'check'
                  : transport === 'ssh'
                    ? 'shield'
                    : 'info'
              }
            />
            <span>
              {transport === 'local'
                ? useExistingExternal
                  ? t('wizard.connectExistingNote')
                  : localLaunchers.length > 0
                    ? t('wizard.createNewNote')
                    : t('wizard.noteLocal')
                : transport === 'ssh'
                  ? t('wizard.noteSsh')
                  : t('wizard.noteHttp')}
            </span>
          </div>
        </div>
      )}
    </Modal>
  )
}

function TypeCard(props: {
  transport: 'local' | 'ssh' | 'http'
  pressed: boolean
  onClick: () => void
}): ReactNode {
  const t = useAppStore((state) => state.t)
  const copy: Record<
    'local' | 'ssh' | 'http',
    { titleKey: MessageKey; descKey: MessageKey }
  > = {
    local: { titleKey: 'wizard.typeLocal', descKey: 'wizard.typeLocalDesc' },
    ssh: { titleKey: 'wizard.typeSsh', descKey: 'wizard.typeSshDesc' },
    http: { titleKey: 'wizard.typeHttp', descKey: 'wizard.typeHttpDesc' }
  }
  return (
    <button
      className="type-card"
      data-transport={props.transport}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      data-testid={`type-${props.transport}`}
    >
      <span className="tc-icon">
        <Icon name={TYPE_INFO[props.transport].icon} />
      </span>
      <b>{t(TYPE_INFO[props.transport].labelKey)}</b>
      <span>{t(copy[props.transport].titleKey)}</span>
      <span>{t(copy[props.transport].descKey)}</span>
    </button>
  )
}