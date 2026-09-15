import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { AuthStateEvent, AuthStateSnapshot } from '@shared/contracts'
import { Icon } from '../lib/icons'
import { Modal } from './Modal'

const BRIDGE = window.dshHub

/**
 * 认证面板（T8,设计稿 auth-panel / 设计文档 §5.3）。
 *
 * 状态流(分步是唯一 UI 形态,不做密码+验证码同屏):
 *   needs-auth / await-credentials → 密码屏
 *   await-otp                     → 6 位验证码屏(可切备份码)
 *   锁定(lockedForMs>0)          → 倒计时,期间禁用提交
 *   onboarding                    → 引导(改初始密码在实例页面内完成)
 * 凭据只在提交时经 IPC 瞬时传递,不写 localStorage、不进日志。
 */
export default function AuthPanel(): ReactNode {
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null)
  const [state, setState] = useState<AuthStateSnapshot | null>(null)
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [useBackup, setUseBackup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!BRIDGE) return
    return BRIDGE.auth.onState((event: AuthStateEvent) => {
      setTarget((current) =>
        current && current.id === event.instanceId
          ? current
          : current ?? { id: event.instanceId, name: event.instanceId.slice(0, 8) }
      )
      setState(event.state)
      setError(null)
      if (event.state.phase === 'connected') setTarget(null)
    })
  }, [])

  // 锁定倒计时每秒刷新
  useEffect(() => {
    if (!state || state.lockedForMs <= 0) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [state, tick])

  /** 供工作区浮层/详情页调用的入口(通过自定义事件打开) */
  useEffect(() => {
    const open = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; name: string }>).detail
      setTarget(detail)
      void BRIDGE?.auth.probe(detail.id).then((result) => {
        if (result?.ok) setState(result.value)
      })
    }
    window.addEventListener('dsh-hub:open-auth', open)
    return () => window.removeEventListener('dsh-hub:open-auth', open)
  }, [])

  if (!target || !state) return null

  const locked = state.lockedForMs > 0
  const lockedSeconds = Math.max(1, Math.ceil(state.lockedForMs / 1000))
  const phase = state.phase

  const submit = async (): Promise<void> => {
    if (!BRIDGE || busy || locked) return
    setBusy(true)
    setError(null)
    try {
      // 验证码阶段复用同一次密码经单请求带码提交(设计 §5.2);密码屏只提交密码
      const result = await BRIDGE.auth.login(target.id, password, otp === '' ? undefined : otp)
      if (result.ok && result.value) setState(result.value)
      else if (!result.ok) setError(result.message)
    } finally {
      setBusy(false)
      setOtp('')
    }
  }

  const close = (): void => {
    setTarget(null)
    setPassword('')
    setOtp('')
    setError(null)
  }

  // 密码屏:needs-auth 与 await-credentials 都渲染(await-credentials 仅用于失败回退)
  const isPasswordPhase = phase !== 'await-otp'
  const title =
    phase === 'await-otp' ? '输入动态验证码' : phase === 'connected' ? '已连接' : '需要登录'

  return (
    <Modal
      title={title}
      sub={`${target.name} · ${phase}`}
      onClose={close}
      testId="auth-panel"
      footer={
        <>
          <span className="meta">
            {locked
              ? `失败次数过多，请等待 ${lockedSeconds}s`
              : '凭据仅用于本次登录，不会写入磁盘'}
          </span>
          <div className="right">
            <button className="btn btn-secondary" onClick={close}>
              取消
            </button>
            <button
              className="btn btn-primary"
              data-testid="auth-submit"
              onClick={() => void submit()}
              disabled={busy || locked || (phase === 'await-otp' ? otp === '' : password === '')}
              title={phase === 'await-otp' && password === '' ? '需要复用本次登录的密码' : undefined}
            >
              {busy ? '提交中…' : locked ? `锁定 ${lockedSeconds}s` : '登录'}
            </button>
          </div>
        </>
      }
    >
      {state.needsOnboarding && (
        <div className="note n-warn" data-testid="auth-onboarding">
          <Icon name="alert" />
          <span>该实例仍在使用初始密码，请先在实例页面内完成改密（设置新密码）后再登录。</span>
        </div>
      )}

      {state.message && (
        <div className="note n-err" data-testid="auth-message">
          <Icon name="alert" />
          <span>{state.message}</span>
        </div>
      )}

      {phase === 'await-otp' && password === '' && (
        <div className="field mt12">
          <label htmlFor="auth-password-otp">密码（验证码需与密码同一次提交）</label>
          <input
            id="auth-password-otp"
            className="input"
            type="password"
            value={password}
            data-testid="auth-password-in-otp"
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
      )}

      {isPasswordPhase ? (
        <div className="field mt12">
          <label htmlFor="auth-password">密码</label>
          <input
            id="auth-password"
            className="input"
            type="password"
            autoFocus
            value={password}
            data-testid="auth-password"
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
          />
        </div>
      ) : (
        <div className="field mt12">
          <label htmlFor="auth-otp">{useBackup ? '备份码' : '6 位动态验证码'}</label>
          <input
            id="auth-otp"
            className="input num"
            autoFocus
            inputMode={useBackup ? 'text' : 'numeric'}
            value={otp}
            data-testid="auth-otp"
            onChange={(event) => setOtp(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit()
            }}
          />
          <button
            className="btn btn-ghost btn-sm mt12"
            data-testid="auth-toggle-backup"
            onClick={() => {
              setUseBackup((value) => !value)
              setOtp('')
            }}
          >
            {useBackup ? '改用动态验证码' : '改用备份码'}
          </button>
        </div>
      )}

      {state.otpEnabled && phase !== 'await-otp' && (
        <div className="hintbar mt12">
          <Icon name="shield" />
          <span>该实例启用了二因素认证，提交密码后会要求输入验证码。</span>
        </div>
      )}

      {error && (
        <div className="note n-err mt12">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      )}
    </Modal>
  )
}
