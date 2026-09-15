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

const STEP_LABELS = ['连接方式', '配置', '确认']

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

/** 创建向导(设计稿 wizard):三步 —— 类型 → 表单 → 确认;本期本地分支创建后自动启动并开窗 */
export default function Wizard(): ReactNode {
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
    if (!form.name.trim()) return '请填写实例名称'
    if (transport === 'ssh') {
      if (!form.host.trim()) return '请填写主机或 SSH 别名'
      if (!form.username.trim()) return '请填写 SSH 用户名'
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
    toast('ok', `「${result.value.name}」已创建`)
    void refreshList()
    // 三种传输都走同一状态链「创建→启动(探测)→就绪→开窗」;状态推进与传输无关
    setPendingOpen(result.value.id)
    const started = await bridge.runtime.start(result.value.id)
    if (!started.ok) {
      toast('err', '启动失败', started.message)
      // 失败事件会在 applyStatus 里把该 id 移出待开集合
    }
  }

  return (
    <Modal
      wide
      title="新建实例"
      sub="三步创建一个可连接的 dsh 实例"
      onClose={() => setWizardOpen(false)}
      testId="wizard"
      footer={
        <>
          <span className="meta">
            {step === 2 && '⌘D 下一步'} {error && <span className="err">{error}</span>}
          </span>
          <div className="right">
            {step > 1 && (
              <button className="btn btn-secondary" onClick={() => setStep(step - 1)} disabled={busy}>
                上一步
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
                下一步
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => void create()}
                disabled={busy}
                data-testid="wizard-create"
              >
                {busy ? '创建中…' : '创建'}
              </button>
            )}
          </div>
        </>
      }
    >
      <div className="stepper">
        {STEP_LABELS.map((label, index) => {
          const n = index + 1
          const cls = n === step ? 'on' : n < step ? 'done' : ''
          return (
            <div key={label} style={{ display: 'contents' }}>
              <span className={`step ${cls}`}>
                <b>{n}</b>
                {label}
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
            <label htmlFor="wizard-name">实例名称</label>
            <input
              className="input"
              id="wizard-name"
              placeholder="例如：开发 · 日常"
              value={form.name}
              onChange={set('name')}
              data-testid="wizard-name"
            />
            <span className="hint">只在本机使用，便于在侧边栏区分不同环境。</span>
          </div>

          {transport === 'local' && (
            <details className="adv mt12">
              <summary>高级设置（版本 / 端口）</summary>
              <div className="grid-2 mt8">
                <div className="field">
                  <label htmlFor="wizard-version">dsh 版本</label>
                  <input
                    className="input num"
                    id="wizard-version"
                    placeholder="留空 = 自动选择最新稳定版"
                    value={form.version}
                    onChange={set('version')}
                  />
                </div>
                <div className="field">
                  <label htmlFor="wizard-port">端口</label>
                  <input
                    className="input num"
                    id="wizard-port"
                    placeholder="留空 = 自动分配（30000+）"
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
                  <label htmlFor="wizard-host">主机（或 ~/.ssh/config 别名）</label>
                  <input
                    className="input"
                    id="wizard-host"
                    placeholder="build-01.internal 或 build-01"
                    value={form.host}
                    onChange={set('host')}
                    data-testid="wizard-host"
                  />
                </div>
                <div className="field">
                  <label htmlFor="wizard-user">用户名</label>
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
                  <label htmlFor="wizard-ssh-port">SSH 端口</label>
                  <input
                    className="input num"
                    id="wizard-ssh-port"
                    value={form.sshPort}
                    onChange={set('sshPort')}
                  />
                </div>
                <div className="field">
                  <label htmlFor="wizard-remote-port">远端 dsh 端口</label>
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
                  复用系统 ssh-agent 与 ~/.ssh/config；密钥内容绝不展示、也不会写入应用存储。
                </span>
              </div>
            </>
          )}

          {transport === 'http' && (
            <>
              <div className="field mt12">
                <label htmlFor="wizard-url">实例网址</label>
                <input
                  className="input num"
                  id="wizard-url"
                  placeholder="https://host:8443"
                  value={form.endpointUrl}
                  onChange={set('endpointUrl')}
                  data-testid="wizard-url"
                />
                <span className="hint">粘贴完整 URL 会自动解析，不支持内嵌凭据。</span>
              </div>
              <div className="mt12">
                <UrlDetect endpointUrl={form.endpointUrl} />
              </div>
            </>
          )}
        </div>
      )}

      {step === 3 && (
        <div data-testid="wizard-step-3">
          <p className="meta">最后确认一遍，名称与地址之后仍可在实例详情里修改。</p>
          <div className="inset mt12">
            <dl className="kv">
              <dt>名称</dt>
              <dd>{form.name}</dd>
              <dt>连接方式</dt>
              <dd>
                {TYPE_INFO[transport].label}
                {transport === 'ssh' && form.username ? ` · ${form.username}@${form.host}` : ''}
              </dd>
              <dt>地址</dt>
              <dd className="num">
                {transport === 'local'
                  ? '127.0.0.1（自动分配端口）'
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
                ? '本机实例创建完成后会自动安装 dsh 并启动，就绪后直接打开工作区。'
                : transport === 'ssh'
                  ? '首次连接需要核对服务器指纹，确认后才会建立加密通道（后续里程碑）。'
                  : '粘贴网址后已在第二步实时探测登录方式。'}
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
  const copy: Record<'local' | 'ssh' | 'http', { title: string; desc: string }> = {
    local: { title: '本机运行的 dsh', desc: '版本按需安装，互不干扰' },
    ssh: { title: '经 SSH 隧道连接', desc: '复用系统密钥与 ssh-agent' },
    http: { title: '直连远程网址', desc: 'dsh 网关登录统一管理' }
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
      <b>{TYPE_INFO[props.transport].label}</b>
      <span>{copy[props.transport].title}</span>
      <span>{copy[props.transport].desc}</span>
    </button>
  )
}