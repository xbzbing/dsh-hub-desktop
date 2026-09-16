import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { VaultPolicy, VaultStatusSnapshot } from '@shared/contracts'
import { canSubmitPolicy, effectivePolicy } from '../lib/vault-policy'
import { Icon } from '../lib/icons'

import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/**
 * 凭据存储卡。凭据仅在用户显式选择后保存；默认只保留在当前会话内存中。
 * safeStorage 不可用时后端使用内存存储，界面显示警告。
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
   * 勾选态必须来自主进程策略快照，避免提交默认值覆盖已保存策略或删除凭据。
   */
  const effective = effectivePolicy(status, instanceId)
  // 快照到达前禁止交互，避免以默认值覆盖已保存凭据。
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
