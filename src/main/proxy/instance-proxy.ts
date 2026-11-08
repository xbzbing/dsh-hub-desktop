/**
 * 远程 HTTP 实例的代理接线。
 *
 * 代理挂在每个实例自己的持久化分区 session 上（`persist:inst-<id>`），这样：
 * - 工作区 WebContentsView 与独立实例窗口天然共享同一份代理；
 * - 健康探测/认证请求经 `createSessionFetch` 走同一个 session，行为一致；
 * - 切换实例不会互相污染代理配置。
 *
 * 代理密码不写注册表：apply/fetch 时从 vault 读取。工作区页面的代理认证
 * 由 Chromium 触发 `app.on('login')`，装配层调用 `handleLogin` 按 session 找到实例。
 */
import { session as electronSession, type Session, type WebContents } from 'electron'
import type { HttpInstance } from '@shared/contracts'
import { proxyRulesFor, proxyUsesAuth } from '@shared/contracts'
import { createSessionFetch, type ProxyAuth } from './session-fetch'

export interface InstanceProxyOptions {
  /** 从 vault 读取代理密码；没有则返回 null。 */
  getProxyPassword: (instanceId: string) => Promise<string | null>
  /** 测试注入；默认按实例 id 取 `persist:inst-<id>`。 */
  sessionFor?: (instanceId: string) => Session
  onError?: (error: unknown) => void
}

export interface ProxyLoginEvent {
  preventDefault(): void
}

export interface InstanceProxy {
  /** 应用实例当前配置的代理；配置未变时直接返回。 */
  apply(instance: HttpInstance): Promise<void>
  /** 返回绑定到实例 session 与代理认证的 fetch。 */
  fetchFor(instance: HttpInstance): Promise<typeof fetch>
  /** 代理要求认证时，按 session 找到实例并回填用户名/密码；返回是否已处理。 */
  handleLogin(
    event: ProxyLoginEvent,
    webContents: WebContents | null,
    authInfo: { isProxy: boolean },
    callback: (username?: string, password?: string) => void
  ): boolean
  /** 删除实例时清理内存映射。 */
  forget(instanceId: string): void
}

export function createInstanceProxy(options: InstanceProxyOptions): InstanceProxy {
  const onError =
    options.onError ?? ((error: unknown) => console.error('[proxy] 应用代理失败：', error))
  const sessionFor =
    options.sessionFor ??
    ((instanceId: string) => electronSession.fromPartition(partitionOf(instanceId)))

  /** 已成功应用到 session 的代理规则与凭据版本；两者任一变化都要重建连接。 */
  const applied = new Map<string, { rules: string; authRevision: number }>()
  /** 同实例 apply 串行化，避免 setProxy 竞态后落成旧配置。 */
  const chains = new Map<string, Promise<void>>()
  /** 当前实例的代理认证信息；每次 apply/fetch 都按最新密码更新。 */
  const authById = new Map<string, ProxyAuth | null>()
  /** 凭据版本：密码/用户名变化时递增，供连接池失效判断。 */
  const authRevisionById = new Map<string, number>()
  let nextAuthRevision = 1
  /** session → 实例 id，供工作区页面的 proxy login 事件回查。 */
  const instanceBySession = new Map<Session, string>()
  const sessionById = new Map<string, Session>()

  async function authFor(instance: HttpInstance): Promise<ProxyAuth | null> {
    const username = proxyUsesAuth(instance.proxy) ? instance.proxy?.username : null
    if (!username) return null
    const password = await options.getProxyPassword(instance.id)
    // 空串同样视为无密码：避免把损坏的 vault 值交给代理反复认证。
    if (!password) return null
    return { username, password }
  }

  function sameAuth(left: ProxyAuth | null, right: ProxyAuth | null): boolean {
    return left?.username === right?.username && left?.password === right?.password
  }

  /** 记录最新凭据；只有用户名/密码实际变化时递增版本。 */
  async function rememberAuth(instance: HttpInstance): Promise<number> {
    const next = await authFor(instance)
    const previous = authById.get(instance.id) ?? null
    let revision = authRevisionById.get(instance.id) ?? 0
    if (!sameAuth(previous, next)) {
      revision = nextAuthRevision
      nextAuthRevision += 1
      authRevisionById.set(instance.id, revision)
    }
    authById.set(instance.id, next)
    return revision
  }

  function rememberSession(instanceId: string, target: Session): void {
    const previous = sessionById.get(instanceId)
    if (previous && previous !== target) instanceBySession.delete(previous)
    sessionById.set(instanceId, target)
    instanceBySession.set(target, instanceId)
  }

  async function applyNow(
    instance: HttpInstance,
    rules: string,
    authRevision: number
  ): Promise<void> {
    const target = sessionFor(instance.id)
    rememberSession(instance.id, target)
    const current = applied.get(instance.id)
    if (current?.rules === rules && current.authRevision === authRevision) return
    try {
      if (current?.rules !== rules) {
        await target.setProxy(
          rules === 'direct'
            ? { mode: 'direct' }
            : {
                mode: 'fixed_servers',
                proxyRules: rules,
                // 显式配置代理时连回环也走代理；Chromium 默认的 `<-loopback>` 会绕过本机目标。
                proxyBypassRules: '<-loopback>'
              }
        )
      }
      // 代理规则或凭据变化后关闭旧连接池，避免新请求复用按旧配置建立的 socket。
      await target.closeAllConnections()
      applied.set(instance.id, { rules, authRevision })
    } catch (error) {
      onError(error)
      throw error
    }
  }

  return {
    async apply(instance) {
      const revision = await rememberAuth(instance)
      const rules = proxyRulesFor(instance.proxy) ?? 'direct'
      const previous = chains.get(instance.id) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(() => applyNow(instance, rules, revision))
      chains.set(instance.id, next)
      try {
        await next
      } finally {
        if (chains.get(instance.id) === next) chains.delete(instance.id)
      }
    },

    async fetchFor(instance) {
      const target = sessionFor(instance.id)
      rememberSession(instance.id, target)
      const previousRevision = authRevisionById.get(instance.id)
      const revision = await rememberAuth(instance)
      // 正常路径 apply 已处理连接清理；直接取 fetch 时仍保证换密码后旧连接不残留。
      if (previousRevision !== undefined && revision !== previousRevision) {
        void target.closeAllConnections().catch(onError)
      }
      return createSessionFetch({ session: target, auth: authById.get(instance.id) ?? null })
    },

    handleLogin(event, webContents, authInfo, callback) {
      if (!authInfo.isProxy || webContents === null) return false
      const instanceId = instanceBySession.get(webContents.session)
      if (instanceId === undefined) return false
      const auth = authById.get(instanceId)
      if (!auth) return false
      event.preventDefault()
      callback(auth.username, auth.password)
      return true
    },

    forget(instanceId) {
      const target = sessionById.get(instanceId)
      if (target) instanceBySession.delete(target)
      sessionById.delete(instanceId)
      applied.delete(instanceId)
      authById.delete(instanceId)
      authRevisionById.delete(instanceId)
      chains.delete(instanceId)
    }
  }
}

/** 实例分区名：与 workspace-host/window-host 的 partition 保持同一约定。 */
export function partitionOf(instanceId: string): string {
  return `persist:inst-${instanceId}`
}
