import { useEffect, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { AuthSignalEvent, AuthStateEvent } from '@shared/contracts'
import {
  applyAuthSnapshot,
  applyAuthState,
  clearLock,
  closeAuthPanel,
  initialAuthPanelModel,
  lockExpired,
  lockRemaining,
  lockSeconds,
  openAuthPanel
} from '../lib/auth-panel-state'
import type { AuthPanelModel } from '../lib/auth-panel-state'
import { Icon } from '../lib/icons'
import { Modal } from './Modal'
import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/** 实例名(信号只带 id;取不到时退化为 id 前缀) */
async function instanceNameOf(instanceId: string): Promise<string> {
  const list = await BRIDGE?.instances.list()
  if (list?.ok) {
    const found = list.value.find((item) => item.id === instanceId)
    if (found) return found.name
  }
  return instanceId.slice(0, 8)
}

/**
 * 在飞重探守卫:一个会话失效的页面会因多个子资源发出多条 `auth:signal`,
 * 没有守卫就会对同一实例并发打 N 次网关(并发闸只限流不合并)。
 */
const probing = new Set<string>()

/**
 * 打开面板并立即重探(T9:让 `auth:signal` 有真实消费者)。
 *
 * 面板在拿到快照前 `state` 为 null → 渲染为「无」(见下方 early return),
 * 因此**静默恢复成功时不会闪出登录面板**:重探返回 `connected` 时归约会关闭面板。
 */
async function openAndProbe(
  instanceId: string,
  setModel: Dispatch<SetStateAction<AuthPanelModel>>
): Promise<void> {
  const name = await instanceNameOf(instanceId)
  setModel((current) => openAuthPanel(current, { id: instanceId, name }))
  if (probing.has(instanceId)) return
  probing.add(instanceId)
  try {
    const result = await BRIDGE?.auth.probe(instanceId)
    const value = result?.ok ? result.value : null
    if (value) setModel((current) => applyAuthSnapshot(current, instanceId, value))
  } finally {
    probing.delete(instanceId)
  }
}

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
  // 面板状态经纯归约函数流转(auth-panel-state.ts):跨实例事件被忽略、锁定用绝对到期时刻
  const t = useAppStore((state) => state.t)
  const [model, setModel] = useState(initialAuthPanelModel)
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [useBackup, setUseBackup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 每秒 tick 只用于让「按到期时刻派生」的倒计时重算,不承载状态本身
  const [, setTick] = useState(0)
  // G2 已决边(§5.3):该实例是否可走「已保存的密码」—— 勾选了记住密码且 vault 里
  // 确有条目。这只决定 UI 的提交路径与提示;真正的门禁在主进程(未勾选/无密码 →
  // invalid-input),渲染层无从绕过。
  const [storedAvailable, setStoredAvailable] = useState(false)

  useEffect(() => {
    if (!BRIDGE) return
    return BRIDGE.auth.onState((event: AuthStateEvent) => {
      setModel((current) => applyAuthState(current, event))
      setError(null)
    })
  }, [])

  // 锁定倒计时:每秒重算剩余时间;到期后重探一次,让按钮与文案恢复
  useEffect(() => {
    if (model.lockUntil === null) return
    const timer = setInterval(() => {
      setTick((value) => value + 1)
      if (lockExpired(model)) {
        clearInterval(timer)
        // 评审 R4:先无条件解除锁定,再尝试重探刷新状态 ——
        // 若把解锁绑定在重探成功上,重探返回 null/{ok:false} 时按钮会永久停在「锁定 0s」。
        setModel((current) => clearLock(current))
        const openId = model.target?.id
        if (!openId) return
        void BRIDGE?.auth.probe(openId).then((result) => {
          // 取局部常量:属性收窄不会跨进闭包
          const value = result?.ok ? result.value : null
          if (value) setModel((current) => applyAuthSnapshot(current, openId, value))
        })
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [model])

  /** 供工作区浮层/详情页调用的入口(通过自定义事件打开) */
  useEffect(() => {
    const open = (event: Event): void => {
      const detail = (event as CustomEvent<{ id: string; name: string }>).detail
      setModel((current) => openAuthPanel(current, detail))
      void BRIDGE?.auth.probe(detail.id).then((result) => {
        const value = result?.ok ? result.value : null
        if (value) setModel((current) => applyAuthSnapshot(current, detail.id, value))
      })
    }
    window.addEventListener('dsh-hub:open-auth', open)
    return () => window.removeEventListener('dsh-hub:open-auth', open)
  }, [])

  /**
   * T9:消费拦截层信号(`auth:signal`)—— 会话失效/需二因素/需引导时打开面板并重探。
   * 此前该信号全仓无渲染层消费者(评审 Minor),主进程只能盲目重探。
   */
  useEffect(() => {
    if (!BRIDGE) return
    return BRIDGE.auth.onSignal((event: AuthSignalEvent) => {
      void openAndProbe(event.instanceId, setModel)
    })
  }, [])

  // 打开面板(或切换目标实例/状态推进)时读取 vault 状态,判断「已保存的密码」是否
  // 可用。T8 评审-2 L1:仅随 targetId 刷新可能读到 stale —— 相位变化时重读一次
  // (vault:status 是本地读,代价可忽略),保证提交路径判定不过期。
  const targetId = model.target?.id ?? null
  const targetPhase = model.state?.phase ?? null
  useEffect(() => {
    if (targetId === null || !BRIDGE) {
      setStoredAvailable(false)
      return
    }
    const instanceId = targetId
    let cancelled = false
    void BRIDGE.vault.status().then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setStoredAvailable(false)
        return
      }
      const snapshot = result.value
      setStoredAvailable(
        snapshot.policies[instanceId]?.rememberPassword === true &&
          snapshot.rememberedInstances.includes(instanceId)
      )
    })
    return () => {
      cancelled = true
    }
  }, [targetId, targetPhase])

  const target = model.target
  const state = model.state
  if (!target || !state) return null

  // 以「剩余时间」为准(而非仅看 lockUntil 是否存在):即使 tick 尚未执行也不会误判为锁死
  const locked = lockRemaining(model) > 0
  const lockedSeconds = lockSeconds(model)
  const phase = state.phase

  const submit = async (): Promise<void> => {
    if (!BRIDGE || busy || locked) return
    setBusy(true)
    setError(null)
    try {
      // 验证码阶段复用同一次密码经单请求带码提交(设计 §5.2);密码屏只提交密码。
      // G2 已决边(§5.3):验证码阶段密码留空 + vault 已存密码 → 走 loginStored
      // (密码不跨 IPC,主进程自取),不再强制用户重输密码;失败时仍可手动输入。
      const useStored = phase === 'await-otp' && password === '' && storedAvailable
      const result = useStored
        ? await BRIDGE.auth.loginStored(target.id, otp === '' ? undefined : otp)
        : await BRIDGE.auth.login(target.id, password, otp === '' ? undefined : otp)
      const value = result.ok ? result.value : null
      if (value) setModel((current) => applyAuthSnapshot(current, target.id, value))
      else if (!result.ok) setError(result.message)
    } finally {
      setBusy(false)
      setOtp('')
    }
  }

  const close = (): void => {
    setModel(closeAuthPanel())
    setPassword('')
    setOtp('')
    setError(null)
  }

  // 密码屏:needs-auth 与 await-credentials 都渲染(await-credentials 仅用于失败回退)
  const isPasswordPhase = phase !== 'await-otp'
  const title =
    phase === 'await-otp'
      ? t('auth.titleOtp')
      : phase === 'connected'
        ? t('auth.titleConnected')
        : t('auth.title')

  return (
    <Modal
      closeLabel={t('common.close')}
      title={title}
      sub={`${target.name} · ${phase}`}
      onClose={close}
      testId="auth-panel"
      footer={
        <>
          <span className="meta">
            {locked
              ? t('auth.locked', { seconds: lockedSeconds })
              : t('auth.credentialsLocalOnly')}
          </span>
          <div className="right">
            {/* 用户反馈 #8:认证面板是紧凑浮层,标准按钮(31px)显得过大 —— 与详情页
                操作按钮一致改用 btn-sm(27px),视觉协调 */}
            <button className="btn btn-secondary btn-sm" onClick={close}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              data-testid="auth-submit"
              onClick={() => void submit()}
              // D5:await-otp 阶段验证码必须填;密码在已存密码可用时允许留空(G2),
              // 否则维持「密码+验证码都要有」—— register 侧要求密码 min(1),只禁用
              // 验证码会提交出 invalid-input 而不是给出「按钮不可用」的提示
              disabled={
                busy ||
                locked ||
                (phase === 'await-otp'
                  ? otp === '' || (password === '' && !storedAvailable)
                  : password === '')
              }
              title={
                phase === 'await-otp' && password === ''
                  ? storedAvailable
                    ? t('auth.storedHint')
                    : t('auth.needReusedPassword')
                  : undefined
              }
            >
              {busy
                ? t('auth.submitting')
                : locked
                  ? t('auth.lockButton', { seconds: lockedSeconds })
                  : t('auth.submit')}
            </button>
          </div>
        </>
      }
    >
      {state.needsOnboarding && (
        <div className="note n-warn" data-testid="auth-onboarding">
          <Icon name="alert" />
          <span>{t('auth.onboarding')}</span>
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
          <label htmlFor="auth-password-otp">{t('auth.passwordForOtp')}</label>
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
          <label htmlFor="auth-password">{t('auth.password')}</label>
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
          <label htmlFor="auth-otp">{useBackup ? t('auth.backupCode') : t('auth.otp')}</label>
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
            {useBackup ? t('auth.useOtp') : t('auth.useBackup')}
          </button>
        </div>
      )}

      {phase === 'await-otp' && storedAvailable && (
        <div className="hintbar mt12" data-testid="auth-stored-hint">
          <Icon name="shield" />
          <span>{t('auth.storedHint')}</span>
        </div>
      )}

      {state.otpEnabled && phase !== 'await-otp' && (
        <div className="hintbar mt12">
          <Icon name="shield" />
          <span>{t('auth.otpHint')}</span>
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
