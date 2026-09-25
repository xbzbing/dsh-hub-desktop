/**
 * 保险库通道：状态快照、记住策略、遗忘与整体清除。
 * 外部接管的访问地址映射由装配层注入，遗忘凭据时同步清掉会话内的访问地址。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  VAULT_IPC,
  VaultPolicySchema,
  type IpcResult,
  type VaultPolicy,
  type VaultStatusSnapshot
} from '@shared/contracts'
import type { Vault } from '../vault/vault'
import type { AuditEntry } from '../audit/audit-log'
import { parseId, type ExternalAccessUrls, type IpcWrap } from './ipc-utils'

export interface VaultHandlerDeps {
  vault: Vault
  audit?: (entry: AuditEntry) => void
}

export function registerVaultHandlers(
  deps: VaultHandlerDeps,
  externalAccessUrls: ExternalAccessUrls,
  wrap: IpcWrap
): void {
  /** vault 状态快照(渲染层据此显示降级告警与「已记住」标记) */
  function vaultSnapshot(): VaultStatusSnapshot {
    const status = deps.vault.status()
    const remembered = deps.vault.rememberedIds()
    const policies: Record<string, VaultPolicy> = {}
    for (const id of new Set([...remembered, ...deps.vault.policyIds()])) {
      policies[id] = deps.vault.getPolicy(id)
    }
    return {
      available: status.available,
      degraded: status.degraded,
      rememberedInstances: remembered,
      policies
    }
  }

  ipcMain.handle(VAULT_IPC.status, (): Promise<IpcResult<VaultStatusSnapshot>> =>
    wrap(() => vaultSnapshot())
  )

  ipcMain.handle(
    VAULT_IPC.setPolicy,
    (_event, id: unknown, policy: unknown): Promise<IpcResult<VaultPolicy>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const parsed = VaultPolicySchema.parse(policy)
        await deps.vault.setPolicy(instanceId, parsed)
        return parsed
      })
  )

  ipcMain.handle(
    VAULT_IPC.forget,
    (_event, id: unknown, target: unknown): Promise<IpcResult<VaultPolicy>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        // 缺省 = 两个都忘(UI 的「清除已记住的凭据」)
        const parsed = z
          .object({ password: z.boolean().optional(), session: z.boolean().optional() })
          .strict()
          .nullable()
          .parse(target ?? null)
        const dropPassword = parsed?.password ?? true
        const dropSession = parsed?.session ?? true
        if (dropPassword) await deps.vault.forgetPassword(instanceId)
        if (dropSession) await deps.vault.forgetSession(instanceId)
        // 清除外部访问 token:忘记凭据时一并清理,避免残留的 token 导致下次接管时
        // 用已失效的 token 尝试连接(会报「token 无效」而非正常的重新输入流程)
        externalAccessUrls.delete(instanceId)
        await deps.vault.forgetExternalAccessToken(instanceId)
        // 忘记凭据即取消勾选:否则下一次登录又会把它写回来
        const policy = deps.vault.getPolicy(instanceId)
        const next: VaultPolicy = {
          rememberPassword: dropPassword ? false : policy.rememberPassword,
          rememberSession: dropSession ? false : policy.rememberSession
        }
        await deps.vault.setPolicy(instanceId, next)
        return next
      })
  )

  ipcMain.handle(VAULT_IPC.clear, (): Promise<IpcResult<VaultStatusSnapshot>> =>
    wrap(async () => {
      await deps.vault.clearAll()
      deps.audit?.({ event: 'vault-clear', result: 'ok' })
      return vaultSnapshot()
    })
  )
}
