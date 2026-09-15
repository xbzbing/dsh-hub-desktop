import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { VaultPolicy, VaultStatusSnapshot } from '@shared/contracts'
import { canSubmitPolicy, effectivePolicy } from '../lib/vault-policy'
import { Icon } from '../lib/icons'

import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/**
 * 凭据存储卡（T10,设计文档 §7.2）。
 *
 * 策略是「**显式勾选才持久化**」:默认两个复选框都不勾,凭据只在本次会话内存里。
 * - 勾选「记住密码」→ 登录成功后把密码写入 OS 钥匙串(safeStorage);
 * - 勾选「记住登录态」→ 会话 Cookie 入钥匙串,重启可静默复用;
 * - 「清除已记住的凭据」一并取消勾选 —— 否则清空后下一次登录又会写回来。
 *
 * `safeStorage` 不可用(如无 keyring 的 Linux)时,后端降级为纯内存:
 * 卡片必须**明确告警**,而不是让用户以为勾选生效了。
 */
export default function VaultCard({ instanceId }: { instanceId: string }): ReactNode {
  const t = useAppStore((state) => state.t)
  const [status, setStatus] = useState<VaultStatusSnapshot | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await BRIDGE?.vault.status()
    if (result?.ok) setStatus(result.value)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, instanceId])

  const applyPolicy = async (next: VaultPolicy): Promise<void> => {
    if (!BRIDGE || !interactive) return
    setBusy(true)
    try {
      await BRIDGE.vault.setPolicy(instanceId, next)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    if (!BRIDGE || busy) return
    setBusy(true)
    try {
      const result = await BRIDGE.vault.clear()
      if (result.ok) setStatus(result.value)
    } finally {
      setBusy(false)
    }
  }

  /** 该实例当前是否记住了任何东西 */
  const rememberedHere = status?.rememberedInstances.includes(instanceId) ?? false
  const degraded = status?.degraded ?? false
  /**
   * 勾选态**必须来自主进程的策略快照**,不能只用本地 state:
   * 本地初始化为「都不勾」会让用户看到错误的未勾选状态,随后切换另一个开关时
   * 提交过时的策略对 —— 而 `setPolicy` 对「取消勾选」的语义是真的忘掉,
   * 于是会静默删除已存密码(评审 T10-1 Critical)。
   */
  const effective = effectivePolicy(status, instanceId)
  // 快照到达前禁止交互:否则会以「全 false」兜底值提交,静默清掉已存凭据(复审 F3)
  const interactive = canSubmitPolicy(status, busy)

  return (
    <div className="card" data-testid="vault-card">
      <div className="card-head">
        <h3>{t('vault.title')}</h3>
        <span className="meta">
          {degraded ? t('vault.backendMemory') : t('vault.backendKeychain')}
        </span>
      </div>

      {degraded && (
        <div className="note n-warn mt12" data-testid="vault-degraded">
          <Icon name="alert" />
          <span>{t('vault.degraded')}</span>
        </div>
      )}

      <label className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          data-testid="vault-remember-password"
          checked={effective.rememberPassword}
          disabled={!interactive || !status}
          onChange={(event) =>
            void applyPolicy({ ...effective, rememberPassword: event.target.checked })
          }
        />
        <span>{t('vault.rememberPassword')}</span>
      </label>

      <label className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          data-testid="vault-remember-session"
          checked={effective.rememberSession}
          disabled={!interactive || !status}
          onChange={(event) =>
            void applyPolicy({ ...effective, rememberSession: event.target.checked })
          }
        />
        <span>{t('vault.rememberSession')}</span>
      </label>

      <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
        <button
          className="btn btn-secondary btn-sm"
          data-testid="vault-clear"
          disabled={busy || !status}
          onClick={() => void clear()}
        >
          <Icon name="trash" /> {t('vault.clear')}
        </button>
        <span className="meta" data-testid="vault-state">
          {rememberedHere ? t('vault.remembered') : t('vault.notRemembered')}
        </span>
      </div>

      <p className="meta mt12">{t('vault.otpNeverStored')}</p>
    </div>
  )
}
