import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { VaultPolicy, VaultStatusSnapshot } from '@shared/contracts'
import { Icon } from '../lib/icons'

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
  const [status, setStatus] = useState<VaultStatusSnapshot | null>(null)
  const [policy, setPolicy] = useState<VaultPolicy | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await BRIDGE?.vault.status()
    if (result?.ok) setStatus(result.value)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, instanceId])

  const applyPolicy = async (next: VaultPolicy): Promise<void> => {
    if (!BRIDGE || busy) return
    setBusy(true)
    try {
      const result = await BRIDGE.vault.setPolicy(instanceId, next)
      if (result.ok) setPolicy(result.value)
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
      setPolicy({ rememberPassword: false, rememberSession: false })
    } finally {
      setBusy(false)
    }
  }

  /** 该实例当前是否记住了任何东西 */
  const rememberedHere = status?.rememberedInstances.includes(instanceId) ?? false
  const degraded = status?.degraded ?? false
  const effective: VaultPolicy = policy ?? { rememberPassword: false, rememberSession: false }

  return (
    <div className="card" data-testid="vault-card">
      <div className="card-head">
        <h3>凭据存储</h3>
        <span className="meta">
          {degraded ? '仅本次会话（系统钥匙串不可用）' : '系统钥匙串（safeStorage）'}
        </span>
      </div>

      {degraded && (
        <div className="note n-warn mt12" data-testid="vault-degraded">
          <Icon name="alert" />
          <span>
            系统钥匙串不可用，凭据**不会**写入磁盘，只在本次运行期间保留在内存中；
            重启应用后需要重新登录。
          </span>
        </div>
      )}

      <label className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          data-testid="vault-remember-password"
          checked={effective.rememberPassword}
          disabled={busy}
          onChange={(event) =>
            void applyPolicy({ ...effective, rememberPassword: event.target.checked })
          }
        />
        <span>记住密码（写入系统钥匙串；取消勾选会立即删除已存密码）</span>
      </label>

      <label className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          data-testid="vault-remember-session"
          checked={effective.rememberSession}
          disabled={busy}
          onChange={(event) =>
            void applyPolicy({ ...effective, rememberSession: event.target.checked })
          }
        />
        <span>记住登录态（重启后静默复用会话；取消勾选会立即删除已存会话）</span>
      </label>

      <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
        <button
          className="btn btn-secondary btn-sm"
          data-testid="vault-clear"
          disabled={busy}
          onClick={() => void clear()}
        >
          <Icon name="trash" /> 清除已记住的凭据
        </button>
        <span className="meta" data-testid="vault-state">
          {rememberedHere ? '该实例已记住凭据' : '该实例未记住任何凭据'}
        </span>
      </div>

      <p className="meta mt12">
        动态验证码（TOTP）密钥永不存储 —— 它只存在于你自己的认证器里。
      </p>
    </div>
  )
}
