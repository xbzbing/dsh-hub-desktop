import { BrowserWindow } from 'electron'
import { AUTH_IPC } from '@shared/contracts'
import type { AuthPhase } from '@shared/contracts'
import { mapAuthTransition } from './audit/audit-mapping'
import type { AuditEntry } from './audit/audit-log'
import { createAuthRegistry } from './auth/auth-registry'
import type { AuthRegistry } from './auth/auth-registry'
import { restoreSessionFromVault } from './auth/session-restore'
import type { InstanceStore } from './registry/instance-store'
import type { SshTunnelManager } from './transport/ssh-tunnel'
import { authEndpointOf } from './transport/endpoint-resolver'
import type { Vault } from './vault/vault'

export interface AuthControllerDeps {
  /** 凭据保险库（会话恢复与记住登录态的读写入口）；未装配返回 null */
  getVault: () => Vault | null
  /** 实例注册表（端点解析要读传输配置） */
  store: InstanceStore
  /** SSH 隧道管理器（端点解析取实时隧道端口）；未装配返回 null */
  getTunnels: () => SshTunnelManager | null
  auditWrite: (entry: AuditEntry) => void
}

export interface AuthController {
  auth: AuthRegistry
}

/**
 * AuthRegistry 初始化：端点解析、会话恢复、状态广播与审计接线。
 */
export function createAuthController(deps: AuthControllerDeps): AuthController {
  /** auth 注册表引用(供会话持久化读取 Cookie;装配时赋值) */
  let authRegistryRef: AuthRegistry | null = null
  const lastAuthState = new Map<
    string,
    { phase: AuthPhase; lockedForMs: number; lastErrorCode: string | null }
  >()

  /**
   * 幂等:同一个值已在 vault 里就不再写(避免每次状态推进都写文件)。
   * 失败只记日志:记住登录态是附加能力,不能影响已经成功的登录。
   */
  async function persistSessionIfOptedIn(
    instanceId: string,
    registry: AuthRegistry | null = authRegistryRef
  ): Promise<void> {
    try {
      const vault = deps.getVault()
      if (!vault || !registry) return
      if (!vault.getPolicy(instanceId).rememberSession) return
      const cookie = registry.sessionCookie(instanceId)
      if (!cookie || cookie.value === '') return
      const existing = vault.getSession(instanceId)
      if (existing?.value === cookie.value) return
      await vault.rememberSession(instanceId, cookie)
      deps.auditWrite({ instanceId, event: 'vault-write', result: 'session' })
    } catch (error) {
      console.error('[main] 记住登录态失败(会话已建立)：', error)
    }
  }

  const auth = createAuthRegistry({
    restore: async (instanceId, client) => {
      const vault = deps.getVault()
      if (!vault) return
      await restoreSessionFromVault({ vault }, instanceId, client)
    },
    resolveEndpoint: async (instanceId) => {
      const record = await deps.store.get(instanceId)
      if (!record) return null
      // 只取**实时**隧道端口:注册表的 localPort 可能已陈旧(隧道重启会重新分配),
      // 「隧道已停也要能清 Cookie」的需求由 clearPartitionSession 的 plan 承担。
      const tunnelPort =
        record.transport === 'ssh' ? deps.getTunnels()?.statusOf(instanceId)?.port : undefined
      return authEndpointOf(record, tunnelPort)
    },
    onState: (instanceId, state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(AUTH_IPC.state, {
            instanceId,
            state,
            at: new Date().toISOString()
          })
        }
      }
      const previous = lastAuthState.get(instanceId) ?? null
      for (const entry of mapAuthTransition(instanceId, previous, state)) {
        deps.auditWrite(entry)
      }
      lastAuthState.set(instanceId, {
        phase: state.phase,
        lockedForMs: state.lockedForMs,
        lastErrorCode: state.lastErrorCode
      })
      if (state.phase === 'connected') void persistSessionIfOptedIn(instanceId)
    }
  })

  authRegistryRef = auth
  return { auth }
}
