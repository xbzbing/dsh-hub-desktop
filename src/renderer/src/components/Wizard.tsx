import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CreateInstanceInput } from '@shared/contracts'
import { tryParseEndpoint } from '@shared/endpoint'
import { Icon } from '../lib/icons'
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
  port: string
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
  port: '',
  host: '',
  username: '',
  sshPort: '22',
  remotePort: '3080',
  endpointUrl: '',
  externalAccess: ''
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
  const setPendingOpen = useAppStore((state) => state.setPendingOpen)
  const toast = useAppStore((state) => state.toast)

  const [step, setStep] = useState(1)
  const [transport, setTransport] = useState<'local' | 'ssh' | 'http'>('local')
  const [form, setForm] = useState<WizardForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [localDsh, setLocalDsh] = useState<{ command: string; version: string } | null>(null)
  const [externalWorkspace, setExternalWorkspace] = useState<{
    pid: number
    port: number
    patch: string | null
  } | null>(null)
  const [useExistingExternal, setUseExistingExternal] = useState(false)
  const [localProbeDone, setLocalProbeDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setWizardOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setWizardOpen])

  useEffect(() => {
    if (step !== 2 || transport !== 'local' || localProbeDone) return
    let cancelled = false
    void Promise.all([window.dshHub?.runtime.probeLocalDsh(), window.dshHub?.runtime.scanExternal()]).then(
      ([runtime, external]) => {
        if (!cancelled) {
          setLocalDsh(runtime?.ok ? runtime.value : null)
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


  const set = (key: keyof WizardForm) => (event: { target: { value: string } }) => {
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
      if (!externalWorkspace) {
        setError(t('wizard.errExternalAccess'))
        return
      }
      const adopted = await bridge.runtime.adoptExternal(
        existingExternalInstance.id,
        externalWorkspace.pid,
        form.externalAccess.trim()
      )
      setBusy(false)
      if (!adopted.ok) {
        setError(adopted.message)
        return
      }
      setWizardOpen(false)
      void openWorkspace(existingExternalInstance.id)
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
            ...(form.port.trim() !== '' ? { port: Number(form.port) } : {})
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
    const result = await bridge.instances.create(input)
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setWizardOpen(false)
    toast('ok', t('wizard.created', { name: result.value.name }))
    void refreshList()
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
          <span className="meta">
            {step === 2 && t('wizard.nextShortcut')} {error && <span className="err">{error}</span>}
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
              {localDsh && !useExistingExternal && (
                <div className="note n-info mt12" data-testid="wizard-local-dsh">
                  <Icon name="check" />
                  <div>
                    <b>{t('wizard.localDetected', { version: localDsh.version })}</b>
                    <span className="meta">{t('wizard.localDetectedPath')}</span>
                  </div>
                </div>
              )}
              {!localDsh && !useExistingExternal && (
                <details className="adv mt12">
                  <summary>{t('wizard.advanced')}</summary>
                  <div className="grid-2 mt8">
                    <div className="field">
                      <label htmlFor="wizard-version">{t('wizard.versionLabel')}</label>
                      <input
                        className="input num"
                        id="wizard-version"
                        placeholder={t('wizard.versionPlaceholder')}
                        value={form.version}
                        onChange={set('version')}
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
                  </div>
                </details>
              )}
              {(localDsh || useExistingExternal) && !useExistingExternal && (
                <details className="adv mt12">
                  <summary>{t('wizard.advanced')}</summary>
                  <div className="field mt8">
                    <label htmlFor="wizard-port">{t('wizard.portLabel')}</label>
                    <input
                      className="input num"
                      id="wizard-port"
                      placeholder={t('wizard.portPlaceholder')}
                      value={form.port}
                      onChange={set('port')}
                    />
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
                    placeholder="dev"
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
                  : localDsh
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