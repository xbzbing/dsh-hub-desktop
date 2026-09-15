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
        title={changed ? t('ssh.hostKeyChangedTitle') : t('ssh.hostKeyTitle')}
        sub={`${hostKey.target} · ${changed ? t('ssh.hostKeyChangedSub') : t('ssh.hostKeyNewSub')}`}
        onClose={() => replyHostKey('reject')}
        testId="fingerprint-dialog"
        footer={
          <>
            <span className="meta">
              {changed ? t('ssh.hostKeyChangedHint') : t('ssh.hostKeyNewHint')}
            </span>
            <div className="right">
              <button className="btn btn-secondary" onClick={() => replyHostKey('reject')}>
               {t('common.cancel')}
              </button>
              {changed ? (
                <button
                  className="btn btn-danger"
                  data-testid="fingerprint-accept"
                  onClick={() => replyHostKey('trust')}
                >
                  {t('ssh.confirmAdvanced')}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  data-testid="fingerprint-accept"
                  onClick={() => replyHostKey('trust')}
                >
                  {t('ssh.trustAndConnect')}
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
              <b>{t('ssh.hostKeyMismatch')}</b>
              {t('ssh.changedWarning')}
            </span>
          </div>
        ) : (
          <p style={{ fontSize: '12.5px', color: 'var(--muted)' }}>
            {t('ssh.untrustedHint', { target: hostKey.target })}
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
                <Icon name="copy" /> {t('common.copy')}
              </button>
            </div>
          ))}
          {changed && hostKey.previousFingerprints.length > 0 && (
            <div className="meta mt12" data-testid="fingerprint-previous">
              {t('ssh.previouslyTrusted')}
              {hostKey.previousFingerprints.map((entry) => entry.fingerprint).join(' · ')}
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
        title={t('ssh.askpassTitle')}
        sub={askpass.prompt}
        onClose={() => replyAskpass(null)}
        testId="askpass-dialog"
        footer={
          <>
            <span className="meta">{t('ssh.askpassTransient')}</span>
            <div className="right">
              <button className="btn btn-secondary" onClick={() => replyAskpass(null)}>
               {t('common.cancel')}
              </button>
              <button
                className="btn btn-primary"
                data-testid="askpass-submit"
                onClick={() => replyAskpass(secret)}
                disabled={secret === ''}
              >
               {t('ssh.continue')}
              </button>
            </div>
          </>
        }
      >
        <div className="field">
          <label htmlFor="askpass-secret">{t('ssh.askpassLabel')}</label>
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