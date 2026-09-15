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
}

const EMPTY_FORM: WizardForm = {
  name: '',
  version: '',
  port: '',
  host: '',
  username: '',
  sshPort: '22',
  remotePort: '3080',
  endpointUrl: ''
}

/**
 * 设计 §7.1「直连 HTTP 远程实例默认警告『数据面明文』」:保存**之前**就要提示。
 *
 * 方案判定复用 @shared/endpoint 的权威解析(与表单校验、主进程同一份实现):
 * 省略协议按 http:// 补全 → 同样告警;https:// 不告警。未输入/解析失败时不告警。
 * 与 DetailView.tsx 内同名判定保持一致(两处都只在 http 方案下提示)。
 */
function isCleartextEndpoint(endpointUrl: string): boolean {
  const parsed = tryParseEndpoint(endpointUrl)
  return parsed.ok && parsed.endpoint.scheme === 'http'
}

/** 创建向导(设计稿 wizard):三步 —— 类型 → 表单 → 确认;本期本地分支创建后自动启动并开窗 */
export default function Wizard(): ReactNode {
  const t = useAppStore((state) => state.t)
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  const refreshList = useAppStore((state) => state.refreshList)
  const setPendingOpen = useAppStore((state) => state.setPendingOpen)
  const toast = useAppStore((state) => state.toast)

  const [step, setStep] = useState(1)
  const [transport, setTransport] = useState<'local' | 'ssh' | 'http'>('local')
  const [form, setForm] = useState<WizardForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setWizardOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setWizardOpen])

  const set = (key: keyof WizardForm) => (event: { target: { value: string } }) => {
    setForm((current) => ({ ...current, [key]: event.target.value }))
  }

  const formError = (): string | null => {
    if (!form.name.trim()) return t('wizard.errName')
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
    const input: CreateInstanceInput =
      transport === 'local'
        ? {
            transport: 'local',
            name,
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
    // 三种传输都走同一状态链「创建→启动(探测)→就绪→开窗」;状态推进与传输无关
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
                  // 第 1 步(选类型)不需要校验;2→3 与创建前才校验表单
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
              value={form.name}
              onChange={set('name')}
              data-testid="wizard-name"
            />
            <span className="hint">{t('wizard.nameHint')}</span>
          </div>

          {transport === 'local' && (
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
              {/* 设计 §7.1:http:// 直连的数据面是明文,创建前先提示(https 不提示) */}
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
              <dd>{form.name}</dd>
              <dt>{t('wizard.dtTransport')}</dt>
              <dd>
                {t(TYPE_INFO[transport].labelKey)}
                {transport === 'ssh' && form.username ? ` · ${form.username}@${form.host}` : ''}
              </dd>
              <dt>{t('wizard.dtAddress')}</dt>
              <dd className="num">
                {transport === 'local'
                  ? t('wizard.autoPort')
                  : transport === 'ssh'
                    ? `${form.host}:${form.remotePort}`
                    : form.endpointUrl}
              </dd>
            </dl>
          </div>
          <div className="note n-info mt12">
            <Icon name={transport === 'local' ? 'check' : transport === 'ssh' ? 'shield' : 'info'} />
            <span>
              {transport === 'local'
                ? t('wizard.noteLocal')
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