/**
 * 每实例 AuthClient 注册表（T8）—— 不 import electron。
 *
 * 职责:按实例 id 持有 AuthClient(内存),提供探针/登录/验证码/登出/状态快照,
 * 并把状态变化广播给 UI(T8 的 auth-panel 与工作区浮层)。
 * 凭据只在内存中流转:密码/验证码不落盘、不进日志、不进审计。
 */
import type { HttpAuthDetection } from '@shared/contracts'
import type { AuthState } from './gateway-state'
import { createAuthClient, type AuthClient, type AuthClientOptions } from './auth-client'

export type AuthClientFactory = (options: AuthClientOptions) => AuthClient

export interface AuthRegistryOptions {
  /** 实例端点解析(含 basePath):由调用方从注册表读取 */
  resolveEndpoint: (instanceId: string) => Promise<string | null>
  factory?: AuthClientFactory
  onState?: (instanceId: string, state: AuthState) => void
  /** 注入 fetch(测试) */
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface AuthRegistry {
  /** 取得(或惰性创建)实例的客户端 */
  client(instanceId: string): Promise<AuthClient | null>
  /** 丢弃实例客户端(删除实例/登出清理) */
  forget(instanceId: string): void
  /** 状态快照(未创建客户端返回 null) */
  stateOf(instanceId: string): AuthState | null
  /** 探测并尝试静默恢复 */
  probe(instanceId: string): Promise<HttpAuthDetection | null>
  login(instanceId: string, password: string, otp?: string): Promise<AuthState | null>
  submitOtp(instanceId: string, otp: string): Promise<AuthState | null>
  submitBackupCode(instanceId: string, code: string): Promise<AuthState | null>
  logout(instanceId: string): Promise<AuthState | null>
  /** 会话 Cookie(供分区注入);无会话返回 null */
  sessionCookie(instanceId: string): { name: string; value: string; expiresAt: number | null } | null
  clientIds(): string[]
}

export function createAuthRegistry(options: AuthRegistryOptions): AuthRegistry {
  const clients = new Map<string, AuthClient>()
  const factory = options.factory ?? createAuthClient

  async function clientFor(instanceId: string): Promise<AuthClient | null> {
    const existing = clients.get(instanceId)
    if (existing) return existing
    const endpointUrl = await options.resolveEndpoint(instanceId)
    if (!endpointUrl) return null
    const created = factory({
      instanceId,
      endpointUrl,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.now === undefined ? {} : { now: options.now }),
      onState: (state) => options.onState?.(instanceId, state)
    })
    clients.set(instanceId, created)
    return created
  }

  return {
    client: clientFor,
    forget(instanceId) {
      clients.delete(instanceId)
    },
    stateOf(instanceId) {
      return clients.get(instanceId)?.state() ?? null
    },
    async probe(instanceId) {
      const client = await clientFor(instanceId)
      return client ? client.probeAndRestore() : null
    },
    async login(instanceId, password, otp) {
      const client = await clientFor(instanceId)
      return client ? client.login(password, otp) : null
    },
    async submitOtp(instanceId, otp) {
      const client = await clientFor(instanceId)
      return client ? client.submitOtp(otp) : null
    },
    async submitBackupCode(instanceId, code) {
      const client = await clientFor(instanceId)
      return client ? client.submitBackupCode(code) : null
    },
    async logout(instanceId) {
      const client = clients.get(instanceId)
      if (!client) return null
      const state = await client.logout()
      clients.delete(instanceId)
      return state
    },
    sessionCookie(instanceId) {
      const client = clients.get(instanceId)
      if (!client) return null
      const record = client.jar.get('dsh_auth')
      if (!record) return null
      return { name: record.name, value: record.value, expiresAt: record.expiresAt }
    },
    clientIds: () => [...clients.keys()]
  }
}
