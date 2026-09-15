import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AskpassPromptPayload,
  HostKeyDecision,
  HostKeyPromptPayload
} from '@shared/contracts'
import { Icon } from '../lib/icons'
import { Modal } from './Modal'
import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/**
 * SSH 安全确认浮层（T5）：
 * - 主机指纹（TOFU）：首次连接 = 常规确认；指纹变化 = 红色警示 + 默认拒绝（危险按钮才放行）；
 * - 口令输入（askpass）：私钥口令 / 密码，输入后仅经 IPC 瞬时回传，不写入任何存储。
 * 两者都由主进程事件驱动，答完即销毁。
 */
export default function SshDialogs(): ReactNode {
  const t = useAppStore((state) => state.t)
  const [hostKey, setHostKey] = useState<HostKeyPromptPayload | null>(null)
  const [askpass, setAskpass] = useState<AskpassPromptPayload | null>(null)
  const [secret, setSecret] = useState('')

  useEffect(() => {
    if (!BRIDGE) return
    const offHostKey = BRIDGE.ssh.onHostKeyDecision((payload) => setHostKey(payload))
    const offAskpass = BRIDGE.ssh.onAskpassRequest((payload) => {
      setSecret('')
      setAskpass(payload)
    })
    return () => {
      offHostKey()
      offAskpass()
    }
  }, [])

  const replyHostKey = (decision: HostKeyDecision): void => {
    if (!hostKey) return
    void BRIDGE?.ssh.replyHostKey(hostKey.requestId, decision)
    setHostKey(null)
  }

  const replyAskpass = (value: string | null): void => {
    if (!askpass) return
    void BRIDGE?.ssh.replyAskpass(askpass.requestId, value)
    setAskpass(null)
    setSecret('')
  }

  if (hostKey) {
    const changed = hostKey.verdict === 'changed'
    return (
      <Modal
        closeLabel={t('common.close')}
        title={changed ? '服务器指纹已变化' : '连接安全确认'}
        sub={`${hostKey.target} · ${changed ? '与此前信任的不一致' : '首次连接前需核对身份'}`}
        onClose={() => replyHostKey('reject')}
        testId="fingerprint-dialog"
        footer={
          <>
            <span className="meta">
              {changed ? '仅在你已与服务管理员核对过指纹后再继续' : '确认后会写入本机私有 known_hosts'}
            </span>
            <div className="right">
              <button className="btn btn-secondary" onClick={() => replyHostKey('reject')}>
                取消
              </button>
              {changed ? (
                <button
                  className="btn btn-danger"
                  data-testid="fingerprint-accept"
                  onClick={() => replyHostKey('trust')}
                >
                  我已确认（高级）
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  data-testid="fingerprint-accept"
                  onClick={() => replyHostKey('trust')}
                >
                  这是我的服务器，信任并连接
                </button>
              )}
            </div>
          </>
        }
      >
        {changed ? (
          <div className="note n-err" data-testid="fingerprint-changed-warning">
            <Icon name="alert" />
            <span>
              <b>这台服务器出示的指纹与已信任的不一致。</b>
              可能是服务器重装或密钥轮换，也可能是中间人攻击。请先与服务管理员核对，再决定是否继续。
            </span>
          </div>
        ) : (
          <p style={{ fontSize: '12.5px', color: 'var(--muted)' }}>
            「{hostKey.target}」还没有被信任过，请核对下面的指纹是否与服务端一致。
          </p>
        )}
        <div className="inset mt12">
          {hostKey.fingerprints.map((entry) => (
            <div className="row-between" key={entry.fingerprint}>
              <code className="num" style={{ fontSize: '12.5px' }}>
                {entry.typeLabel} · {entry.fingerprint}
              </code>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => void navigator.clipboard.writeText(entry.fingerprint)}
              >
                <Icon name="copy" /> 复制
              </button>
            </div>
          ))}
          {changed && hostKey.previousFingerprints.length > 0 && (
            <div className="meta mt12" data-testid="fingerprint-previous">
              此前信任：{hostKey.previousFingerprints.map((entry) => entry.fingerprint).join(' · ')}
            </div>
          )}
        </div>
      </Modal>
    )
  }

  if (askpass) {
    return (
      <Modal
        closeLabel={t('common.close')}
        title="需要输入 SSH 口令"
        sub={askpass.prompt}
        onClose={() => replyAskpass(null)}
        testId="askpass-dialog"
        footer={
          <>
            <span className="meta">口令只用于本次连接，不会写入磁盘或日志</span>
            <div className="right">
              <button className="btn btn-secondary" onClick={() => replyAskpass(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                data-testid="askpass-submit"
                onClick={() => replyAskpass(secret)}
                disabled={secret === ''}
              >
                继续
              </button>
            </div>
          </>
        }
      >
        <div className="field">
          <label htmlFor="askpass-secret">口令 / 私钥口令</label>
          <input
            id="askpass-secret"
            className="input"
            type="password"
            autoFocus
            value={secret}
            data-testid="askpass-input"
            onChange={(event) => setSecret(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && secret !== '') replyAskpass(secret)
            }}
          />
        </div>
      </Modal>
    )
  }

  return null
}