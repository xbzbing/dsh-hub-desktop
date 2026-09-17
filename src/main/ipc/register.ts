/**
 *
 * 白名单通道（preload 再暴露一层）；非法入参返回 `IpcResult` 错误信封而非抛异常，
 */
import { app, ipcMain } from 'electron'
import { z } from 'zod'
import { EndpointParseError } from '@shared/endpoint'
import { IPC, type AppInfo, type PingResult } from '@shared/bridge'
import {
  AUTH_IPC,
  CreateInstanceInputSchema,
  formatZodIssues,
  HTTP_IPC,
  INSTANCE_IPC,
  INSTANCE_RUNTIME_IPC,
  PatchInstanceSchema,
  SSH_IPC,
  SETTINGS_IPC,
  SshKeyPreviewInputSchema,
  VAULT_IPC,
  VaultPolicySchema,
  WorkspaceViewBoundsSchema,
  type HostKeyDecision,
  type AuthStateSnapshot,
  type ExternalDshWebSnapshot,
  type HttpAuthDetection,
  type InstanceRecord,
  type VaultPolicy,
  type VaultStatusSnapshot,
  type InstanceSummary,
  type InstanceRuntimeStatus,
  type IpcResult,
  type LocalDshSnapshot,
  type WorkspaceViewBounds
} from '@shared/contracts'
import { detectDraftEndpoint } from '../transport/http-endpoint'
import { httpDirectEndpoint } from '../transport/endpoint-resolver'
import type { HttpEndpointManager } from '../transport/http-endpoint'
import { resolveSshKeyPreview } from '../ssh/key-preview'
import type { PromptBroker } from '../ssh/prompt-broker'
import type { AuthRegistry } from '../auth/auth-registry'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import type { ExternalDshScanner } from '../local-runtime/external-dsh'
import type { PathProbe } from '../local-runtime/runtime-source'
import type { SshTunnelManager } from '../transport/ssh-tunnel'
import { InstanceStoreError, type InstanceStore } from '../registry/instance-store'
import { DataDirOpenError } from '../shell/open-data-dir'
import type { Vault } from '../vault/vault'
import type { SettingsStore } from '../settings/settings-store'
import { SettingsSchema } from '@shared/settings'
import type { Settings } from '@shared/settings'
import type { AuditEntry } from '../audit/audit-log'

async function defaultVerifyExternalAccess(url: string): Promise<boolean> {
  const response = await fetch(url, { redirect: 'manual' })
  return response.status !== 401 && response.status !== 403
}

export interface IpcDeps {
  runtime: LocalRuntimeManager
  /**
   * 缺省不装配(单测)→ scan 返回空列表、adopt 一律 invalid-state。
   */
  externalDsh?: ExternalDshScanner
  /** 只读探测本机可执行 dsh，供创建向导选择是否使用。 */
  pathProbe?: PathProbe
  tunnels: SshTunnelManager
  /**
   * 打开实例视图窗口（electron 侧实现，便于 register 单测注入假实现）。
   * 调用方必须 await —— 否则 IPC 会在视图真正就绪前返回。
   */
  openInstanceView: (instance: InstanceRecord, url: string) => Promise<void>
  /** 隐藏当前内嵌工作区，不向渲染层暴露访客 WebContents。 */
  hideInstanceView?: () => void
  /** 主进程应用经校验的内容区边界。 */
  setInstanceViewBounds?: (bounds: WorkspaceViewBounds) => void
  prompts: PromptBroker
  http: HttpEndpointManager
  auth: AuthRegistry
  clearPartitionSession?: (instanceId: string) => Promise<void>
  /**
   * 才在登录成功时写入,勾选取消即忘掉。
   */
  /** 用户显式提供的外部本机 dsh token 必须通过本机端点验收后才持久化。 */
  verifyExternalAccess?: (url: string) => Promise<boolean>
  vault: Vault
  settings: SettingsStore
  /**
   * 缺省不执行(单测);落盘由本模块负责,副作用交给装配层。
   */
  onSettingsChanged?: (settings: Settings, changedKeys: readonly (keyof Settings)[]) => void
  /**
   *
   * **签名上没有路径参数**——目录由装配层自行解析(`DSH_HUB_DATA_DIR` /
   * `app.getPath('userData')`),渲染层无从指定,故不可能成为任意文件打开原语。
   * 缺省时该通道返回 internal 错误信封(单测不装配)。
   */
  openDataDir?: () => Promise<void>
  /**
   * 审计写入本身异步且失败隔离,不阻塞业务。
   */
  audit?: (entry: AuditEntry) => void
}

async function wrap<T>(task: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await task() }
  } catch (error) {
    if (error instanceof InstanceStoreError) {
      return { ok: false, code: error.code, message: error.message }
    }
    if (error instanceof z.ZodError) {
      return { ok: false, code: 'invalid-input', message: formatZodIssues(error) }
    }
    // 端点解析失败属输入问题(不是内部错误):与 instances:create 的 tryParseEndpoint 口径一致
    if (error instanceof EndpointParseError) {
      return { ok: false, code: 'invalid-input', message: error.message }
    }
    // 打开数据目录失败:带稳定错误码(io-error/internal)显式回报,
    if (error instanceof DataDirOpenError) {
      return { ok: false, code: error.code, message: error.message }
    }
    // 内部错误不透传细节(可能含 fs 路径),只记主进程日志
    console.error('[ipc] 未预期错误：', error)
    return { ok: false, code: 'internal', message: '内部错误，请查看主进程日志' }
  }
}

function parseId(id: unknown): string {
  return z.uuid().parse(id)
}

/**
 * 将用户提供的 token 或 dsh 输出的完整地址收敛为已验证的回环 URL。
 * token 只由主进程保存在当前会话中，不能进入注册表、状态事件或日志。
 */
function externalAccessToken(raw: unknown, port: number): string {
  const access = z.string().trim().min(1).max(4096).parse(raw)
  if (!access.includes('://')) {
    if (/\s/.test(access)) throw new InstanceStoreError('invalid-input', '访问 token 不能包含空白')
    return access
  }
  let url: URL
  try {
    url = new URL(access)
  } catch {
    throw new InstanceStoreError('invalid-input', '访问链接无法解析')
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
    url.port !== String(port) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new InstanceStoreError('invalid-input', '访问链接必须匹配已检测的本机 dsh 端口并包含 token')
  }
  const token = url.searchParams.get('token')
  if (token === null || token === '') {
    throw new InstanceStoreError('invalid-input', '访问链接必须匹配已检测的本机 dsh 端口并包含 token')
  }
  return token
}

/** 将 token 拼入已由主进程重新扫描确认的回环端口。 */
function externalAccessUrl(token: string, port: number): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
}

function toSummary(record: InstanceRecord, runtimeStatus?: InstanceRuntimeStatus): InstanceSummary {
  const address =
    record.transport === 'local'
      ? `127.0.0.1:${record.port ?? '—'}`
      : record.transport === 'ssh'
        ? `${record.host}:${record.remotePort}`
        : record.endpointUrl
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    authMode: record.authMode,
    address,
    ...(runtimeStatus ? { runtimeStatus } : {}),
    updatedAt: record.updatedAt
  }
}

export function registerIpc(store: InstanceStore, deps: IpcDeps): void {
  /** 外部 dsh 的 token URL 仅驻留在主进程会话内，绝不进入状态流或注册表。 */
  const externalAccessUrls = new Map<string, { pid: number; port: number; url: string }>()
  const processVersions = process.versions as NodeJS.ProcessVersions & { electron?: string }

  ipcMain.handle(IPC.info, (): Promise<IpcResult<AppInfo>> =>
    wrap((): AppInfo => ({
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      chrome: process.versions.chrome,
      electron: processVersions.electron ?? '',
      node: process.versions.node,
      userDataPath: app.getPath('userData')
    }))
  )

  ipcMain.handle(IPC.ping, (_event, message: unknown): Promise<IpcResult<PingResult>> =>
    wrap((): PingResult => {
      const echo = typeof message === 'string' && message !== '' ? message : null
      return { echo, at: Date.now() }
    })
  )

  // —— 实例注册表 CRUD ——

  function statusFor(record: InstanceRecord): InstanceRuntimeStatus | undefined {
    return record.transport === 'ssh'
      ? deps.tunnels.statusOf(record.id)?.status
      : record.transport === 'http'
        ? deps.http.statusOf(record.id)?.status
        : deps.runtime.statusOf(record.id)?.status
  }

  ipcMain.handle(INSTANCE_IPC.list, (): Promise<IpcResult<InstanceSummary[]>> =>
    wrap(() => store.list().then((records) => records.map((record) => toSummary(record, statusFor(record)))))
  )

  ipcMain.handle(INSTANCE_IPC.get, (_event, id: unknown): Promise<IpcResult<InstanceRecord | null>> =>
    wrap(() => store.get(parseId(id)))
  )

  ipcMain.handle(INSTANCE_IPC.create, (_event, input: unknown): Promise<IpcResult<InstanceRecord>> =>
    wrap(async () => {
      const parsed = CreateInstanceInputSchema.parse(input)
      if (parsed.transport !== 'local') return store.create(parsed)
      const { useExistingExternal, externalPid, externalAccess, ...recordInput } = parsed
      if (useExistingExternal !== true) return store.create(recordInput)
      if (!deps.externalDsh) throw new InstanceStoreError('invalid-state', '本机进程探测能力不可用')
      const pid = z.number().int().positive().parse(externalPid)
      const found = await deps.externalDsh.scan()
      const match = found.find((item) => item.pid === pid)
      if (!match) throw new InstanceStoreError('not-found', `未找到 pid ${pid} 的 dsh web 进程`)
      if (match.port === null) throw new InstanceStoreError('invalid-state', '该进程的监听端口未能确定，无法接管')
      const token = externalAccessToken(externalAccess, match.port)
      const accessUrl = externalAccessUrl(token, match.port)
      if (!(await (deps.verifyExternalAccess ?? defaultVerifyExternalAccess)(accessUrl))) {
        throw new InstanceStoreError('invalid-state', '访问 token 无效，请重新输入')
      }
      const record = await store.create({ ...recordInput, port: match.port })
      if (record.transport !== 'local') throw new Error('本机实例创建结果无效')
      externalAccessUrls.set(record.id, { pid: match.pid, port: match.port, url: accessUrl })
      await deps.vault.rememberExternalAccessToken(record.id, token)
      await deps.runtime.adopt(record, { pid: match.pid, port: match.port, patch: match.patch })
      return record
    })
  )

  ipcMain.handle(
    INSTANCE_IPC.update,
    (_event, id: unknown, patch: unknown): Promise<IpcResult<InstanceRecord>> =>
      wrap(() => store.update(parseId(id), PatchInstanceSchema.parse(patch)))
  )

  ipcMain.handle(
    INSTANCE_IPC.delete,
    (_event, id: unknown): Promise<IpcResult<{ removed: boolean }>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        // 详情页文案承诺「删除运行中的实例会先停止其进程」:先回收进程树再移除记录,
        // 否则 dsh/ssh 进程继续存活(独占端口与 DSH_HOME),窗口也无 stopped 事件可回收
        const record = await store.get(instanceId)
        externalAccessUrls.delete(instanceId)
        await deps.vault.forgetExternalAccessToken(instanceId)
        if (record?.transport === 'ssh') await deps.tunnels.stop(instanceId)
        else if (record?.transport === 'http') await deps.http.stop(instanceId)
        else if (record?.transport === 'local') await deps.runtime.stop(instanceId)
        deps.hideInstanceView?.()
        deps.auth.forget(instanceId)
        await deps.vault.forgetInstance(instanceId)
        await deps.clearPartitionSession?.(instanceId).catch(() => undefined)
        return { removed: await store.remove(instanceId) }
      })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.start, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instance = await store.get(parseId(id))
      if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)
      if (instance.transport === 'local') {
        // 不 await：安装/启动可能耗时数十秒，进展与失败都走状态事件
        void deps.runtime.start(instance)
        return null
      }
      if (instance.transport === 'ssh') {
        void deps.tunnels.start(instance)
        return null
      }
      if (instance.transport === 'http') {
        void deps.http.start(instance)
        return null
      }
      throw new InstanceStoreError('invalid-input', '未知的传输类型')
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.stop, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      externalAccessUrls.delete(instanceId)
      const record = await store.get(instanceId)
      if (record?.transport === 'ssh') await deps.tunnels.stop(instanceId)
      else if (record?.transport === 'http') await deps.http.stop(instanceId)
      else await deps.runtime.stop(instanceId) // local 或不存在:runtime.stop 幂等
      return null
    })
  )

  const openViewTasks = new Map<string, Promise<void>>()

  async function openWorkspace(instanceId: string): Promise<void> {
    const instance = await store.get(instanceId)
    if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${instanceId}`)
    const status =
      instance.transport === 'ssh'
        ? deps.tunnels.statusOf(instanceId)
        : instance.transport === 'http'
          ? deps.http.statusOf(instanceId)
          : deps.runtime.statusOf(instanceId)
    if (
      status?.status === 'running' &&
      status.url &&
      !(instance.transport === 'local' && status.runtimeSource === 'external')
    ) {
      await deps.openInstanceView(instance, status.url)
      return
    }
    if (instance.transport === 'http') {
      if (status?.status !== 'starting') {
        void deps.http.start(instance).catch((error: unknown) => {
          console.error('[register] HTTP 实例状态探测失败：', error)
        })
      }
      await deps.openInstanceView(instance, httpDirectEndpoint(instance))
      return
    }
    if (instance.transport === 'ssh') {
      await deps.tunnels.start(instance)
      const ready = deps.tunnels.statusOf(instanceId)
      if (ready?.status === 'running' && ready.url) {
        await deps.openInstanceView(instance, ready.url)
      }
      return
    }
    if (instance.transport === 'local') {
      const savedAccess = externalAccessUrls.get(instanceId)
      if (savedAccess) {
        const external = deps.externalDsh ? await deps.externalDsh.scan() : []
        const match = external.find((item) => item.pid === savedAccess.pid && item.port === savedAccess.port)
        if (!match) {
          externalAccessUrls.delete(instanceId)
          throw new InstanceStoreError('not-found', '已接管的本机 dsh web 已停止')
        }
        await deps.openInstanceView(instance, savedAccess.url)
        return
      }
      const external = deps.externalDsh ? await deps.externalDsh.scan() : []
      const match = external.find((item) => item.port === instance.port)
      if (match && match.port !== null) {
        const token = deps.vault.getExternalAccessToken(instanceId)
        if (!token) {
          throw new InstanceStoreError('invalid-state', '需要输入该本机 dsh 的访问 token')
        }
        const accessUrl = externalAccessUrl(token, match.port)
        if (!(await (deps.verifyExternalAccess ?? defaultVerifyExternalAccess)(accessUrl))) {
          await deps.vault.forgetExternalAccessToken(instanceId)
          throw new InstanceStoreError('invalid-state', '已保存的访问 token 无效，请重新输入')
        }
        await deps.runtime.adopt(instance, { pid: match.pid, port: match.port, patch: match.patch })
        externalAccessUrls.set(instanceId, { pid: match.pid, port: match.port, url: accessUrl })
        await deps.openInstanceView(instance, accessUrl)
        return
      }
      await deps.runtime.start(instance)
      const ready = deps.runtime.statusOf(instanceId)
      if (ready?.status === 'running' && ready.url) {
        await deps.openInstanceView(instance, ready.url)
      }
      return
    }
    throw new InstanceStoreError('invalid-input', '未知的传输类型')
  }

  ipcMain.handle(INSTANCE_RUNTIME_IPC.openView, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const existing = openViewTasks.get(instanceId)
      if (existing) {
        await existing
        return null
      }
      const task = openWorkspace(instanceId)
      openViewTasks.set(instanceId, task)
      try {
        await task
      } finally {
        if (openViewTasks.get(instanceId) === task) openViewTasks.delete(instanceId)
      }
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.probeLocalDsh, (): Promise<IpcResult<LocalDshSnapshot | null>> =>
    wrap(async () => {
      const found = await deps.pathProbe?.probe()
      return found ? { command: found.command, version: found.version } : null
    })
  )

  ipcMain.handle(
    INSTANCE_RUNTIME_IPC.scanExternal,
    (): Promise<IpcResult<ExternalDshWebSnapshot[]>> =>
      wrap(async () => {
        // 无参数:渲染层指定不了探测目标(只读 ps+lsof,不做任何写入)
        if (!deps.externalDsh) return []
        const found = await deps.externalDsh.scan()
        // 只暴露 UI 需要的字段,并限制条数(避免异常环境下列表爆炸)
        return found.slice(0, 10).map((item) => ({
          pid: item.pid,
          port: item.port,
          patch: item.patch,
          command: item.command
        }))
      })
  )

  ipcMain.handle(
    INSTANCE_RUNTIME_IPC.adoptExternal,
    (_event, id: unknown, pid: unknown, access: unknown): Promise<IpcResult<null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const targetPid = z.number().int().positive().parse(pid)
        const instance = await store.get(instanceId)
        if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)
        if (instance.transport !== 'local') {
          throw new InstanceStoreError('invalid-input', '只有本地实例才能接管本机 dsh web')
        }
        if (!deps.externalDsh) {
          throw new InstanceStoreError('invalid-state', '本机进程探测能力不可用')
        }
        // 关键:端口/patch **不采信渲染层** —— 重新扫描并按 pid 认定,
        // 渲染层无法借这个通道让 hub 去连任意地址
        const found = await deps.externalDsh.scan()
        const match = found.find((item) => item.pid === targetPid)
        if (!match) {
          throw new InstanceStoreError('not-found', `未找到 pid ${targetPid} 的 dsh web 进程`)
        }
        if (match.port === null) {
          throw new InstanceStoreError('invalid-state', '该进程的监听端口未能确定，无法接管')
        }
        if (deps.runtime.statusOf(instanceId) !== null) {
          throw new InstanceStoreError('invalid-state', '实例已在运行，不能接管其他本机 dsh web')
        }
        const rawAccess = typeof access === 'string' ? access.trim() : ''
        const usingStoredToken = rawAccess === ''
        const token = usingStoredToken
          ? deps.vault.getExternalAccessToken(instanceId)
          : externalAccessToken(access, match.port)
        if (!token) throw new InstanceStoreError('invalid-state', '需要输入该本机 dsh 的访问 token')
        const accessUrl = externalAccessUrl(token, match.port)
        if (!(await (deps.verifyExternalAccess ?? defaultVerifyExternalAccess)(accessUrl))) {
          if (usingStoredToken) await deps.vault.forgetExternalAccessToken(instanceId)
          throw new InstanceStoreError('invalid-state', '访问 token 无效，请重新输入')
        }
        await deps.runtime.adopt(instance, {
          pid: match.pid,
          port: match.port,
          patch: match.patch
        })
        externalAccessUrls.set(instanceId, { pid: match.pid, port: match.port, url: accessUrl })
        if (!usingStoredToken) await deps.vault.rememberExternalAccessToken(instanceId, token)
        deps.audit?.({ instanceId, event: 'connect', result: 'adopt-external' })
        return null
      })
  )

  ipcMain.handle(SSH_IPC.keyPreview, (_event, input: unknown) =>
    wrap(() => {
      const parsed = SshKeyPreviewInputSchema.parse(input)
      return resolveSshKeyPreview({
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        identityFile: parsed.identityFile ?? null
      })
    })
  )

  ipcMain.handle(
    SSH_IPC.hostKeyReply,
    (_event, requestId: unknown, decision: unknown): Promise<IpcResult<null>> =>
      wrap(() => {
        const id = z.uuid().parse(requestId)
        const value = z.enum(['trust', 'reject']).parse(decision) as HostKeyDecision
        deps.prompts.replyHostKey(id, value)
        return null
      })
  )

  ipcMain.handle(
    SSH_IPC.hostKeyForget,
    (_event, input: unknown): Promise<IpcResult<null>> =>
      wrap(async () => {
        // 只有用户主动「忘记该主机指纹」后,下一次连接才会重新走首次 TOFU 确认。
        const parsed = z.object({ instanceId: z.uuid() }).parse(input)
        const instance = await store.get(parsed.instanceId)
        if (!instance) {
          throw new InstanceStoreError('not-found', `实例不存在：${parsed.instanceId}`)
        }
        if (instance.transport !== 'ssh') {
          throw new InstanceStoreError('invalid-input', '只有 SSH 隧道实例才有主机指纹')
        }
        await deps.tunnels.forgetHostKey(instance)
        return null
      })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.updateViewBounds, (_event, bounds: unknown): Promise<IpcResult<null>> =>
    wrap(() => {
      const parsed = WorkspaceViewBoundsSchema.parse(bounds)
      deps.setInstanceViewBounds?.(parsed)
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.hideView, (): Promise<IpcResult<null>> =>
    wrap(() => {
      deps.hideInstanceView?.()
      return null
    })
  )

  const authSnapshot = (
    state: Awaited<ReturnType<AuthRegistry['login']>>
  ): AuthStateSnapshot | null => (state === null ? null : (state as unknown as AuthStateSnapshot))

  /**
   * 写 vault 的「安静」包装:凭据记忆是**尽力而为**的附加动作,
   * 失败(磁盘满/钥匙串不可用)绝不能把一次成功的登录变成错误。
   */
  async function rememberQuietly(instanceId: string, password: string): Promise<void> {
    try {
      await deps.vault.rememberPassword(instanceId, password)
    } catch (error) {
      console.error('[register] 记住密码失败(登录已成功)：', error)
    }
  }

  /** vault 状态快照(渲染层据此显示降级告警与「已记住」标记) */
  function vaultSnapshot(): VaultStatusSnapshot {
    const status = deps.vault.status()
    const remembered = deps.vault.rememberedIds()
    const policies: Record<string, VaultPolicy> = {}
    for (const id of deps.vault.policyIds()) {
      const policy = deps.vault.getPolicy(id)
      if (policy.rememberPassword || policy.rememberSession) policies[id] = policy
    }
    return {
      available: status.available,
      degraded: status.degraded,
      rememberedInstances: remembered,
      policies
    }
  }

  /**
   * 主进程自行读取。门禁:必须显式勾选「记住密码」且 vault 里确有该实例的密码,
   * 否则 invalid-input(渲染层无从绕过:通道只收实例 id 与可选 OTP)。
   */
  function loginWithStored(instanceId: string, otp?: string): Promise<AuthStateSnapshot | null> {
    if (!deps.vault.getPolicy(instanceId).rememberPassword) {
      throw new InstanceStoreError('invalid-input', '未勾选「记住密码」，没有已保存的密码可用')
    }
    const stored = deps.vault.getPassword(instanceId)
    if (stored === null) {
      throw new InstanceStoreError('invalid-input', '保险库中没有该实例的已存密码')
    }
    return deps.auth.login(instanceId, stored, otp).then(authSnapshot)
  }

  /**
   * 且 vault 已存密码 → 自动用已存密码登录一次。
   *
   * 触发集合 = needs-auth ‖ await-credentials 且未锁定(lockedForMs===0)。
   * **为什么是这两相**:真实状态机下 probe 的终态是 await-credentials,不是
   * needs-auth —— probeAndRestore 识别网关后固定走 probe-gateway → session-absent
   * 仅首探瞬间经过 needs-auth。原实现只认 needs-auth,静默登录在生产不可达。
   * await-otp 不触发:已到验证码阶段,密码复用走 AuthPanel 的 loginStored(otp)。
   *
   * 两条会话内记忆(进程生命周期,不落盘):
   * - `storedLoginAttempted`:每实例只自动尝试一次 —— 401 密码失效/429 限流都不重试;
   * - `logoutSuppressed`:用户显式登出后不再静默登录(否则「登出→探测」立即复活),
   *   直到该实例手动登录成功才解除。重启后记忆清零:重启静默复登是「记住密码」
   * 的既定语义,彻底退出须用「清除已记住的凭据」(vault 忘记)。
   *
   * 审计不在此处发生:状态迁移经 auth:state → 审计映射自动落
   * login-success / login-failed / rate-limited。
   */
  const storedLoginAttempted = new Set<string>()
  const logoutSuppressed = new Set<string>()

  async function autoLoginWithStored(
    instanceId: string,
    state: Awaited<ReturnType<AuthRegistry['stateOf']>>
  ): Promise<Awaited<ReturnType<AuthRegistry['stateOf']>>> {
    if (state === null) return state
    const needsAuth = state.phase === 'needs-auth' || state.phase === 'await-credentials'
    if (!needsAuth || state.lockedForMs > 0) return state
    if (storedLoginAttempted.has(instanceId) || logoutSuppressed.has(instanceId)) return state
    if (!deps.vault.getPolicy(instanceId).rememberPassword) return state
    const stored = deps.vault.getPassword(instanceId)
    if (stored === null) return state
    // 先记账再尝试:无论成败,会话内不再自动重试
    storedLoginAttempted.add(instanceId)
    try {
      return (await deps.auth.login(instanceId, stored, undefined)) ?? state
    } catch (error) {
      // 自动登录是尽力而为:异常(网络等)不能把一次成功的探测变成 IPC 错误
      console.error('[register] 已存密码静默登录失败（不重试）：', error)
      return state
    }
  }

  // Try one silent login when probing finds a stored password and an authentication state.
  ipcMain.handle(AUTH_IPC.probe, (_event, id: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      await deps.auth.probe(instanceId)
      const state = await autoLoginWithStored(instanceId, deps.auth.stateOf(instanceId) as never)
      return authSnapshot(state)
    })
  )

  ipcMain.handle(
    AUTH_IPC.login,
    (_event, id: unknown, password: unknown, otp: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const pwd = z.string().min(1).max(1024).parse(password)
        // 验证码/备份码域:网关 TOTP 位数**可配**(`otpDigits`,默认 6,合法 4-10),
        // 备份码长度也可配(`backupCodeLength`,默认 8,合法 6-12)。
        // 完全无法登录(合法验证码被 zod 拒掉)。
        const code = z.string().trim().min(4).max(12).nullable().parse(otp ?? null)
        const state = await deps.auth.login(instanceId, pwd, code ?? undefined)
        // 失败绝不写(否则一次错误输入会把错密码存进钥匙串);未勾选时 vault 自身也会拒绝。
        if (state?.phase === 'connected' && deps.vault.getPolicy(instanceId).rememberPassword) {
          await rememberQuietly(instanceId, pwd)
          deps.audit?.({ instanceId, event: 'vault-write', result: 'password' })
        }
        // A successful manual login allows future silent login attempts.
        if (state?.phase === 'connected') logoutSuppressed.delete(instanceId)
        return authSnapshot(state)
      })
  )

  // 显式勾选「记住密码」+ vault 里确有密码,否则 invalid-input;密码不跨 IPC。
  ipcMain.handle(
    AUTH_IPC.loginStored,
    (_event, id: unknown, otp: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        // OTP 域与 auth:login 同口径:otpDigits 可配(合法 4-10)、备份码 6-12,下界 4
        const code = z.string().trim().min(4).max(12).nullable().parse(otp ?? null)
        const snapshot = await loginWithStored(instanceId, code ?? undefined)
        // 与 auth:login 同口径:用户以已存密码显式登录成功 = 重新表态,解除登出压制
        if (snapshot?.phase === 'connected') logoutSuppressed.delete(instanceId)
        return snapshot
      })
  )

  ipcMain.handle(AUTH_IPC.logout, (_event, id: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const snapshot = authSnapshot(await deps.auth.logout(instanceId))
      // 「登出 → 任何探测」会立刻用已存密码复活会话。手动登录成功才解除。
      logoutSuppressed.add(instanceId)
      await deps.clearPartitionSession?.(instanceId)
      deps.audit?.({ instanceId, event: 'session-revoked', result: 'logout' })
      deps.audit?.({ instanceId, event: 'cookie-cleared', result: 'logout' })
      return snapshot
    })
  )

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

  ipcMain.handle(
    SETTINGS_IPC.get,
    (): Promise<IpcResult<Settings>> => wrap(() => deps.settings.read())
  )

  ipcMain.handle(
    SETTINGS_IPC.update,
    (_event, patch: unknown): Promise<IpcResult<Settings>> =>
      wrap(async () => {
        // 只接受已知字段的**部分**补丁;未知字段由 .strict() 拒绝。
        // 注意:`.partial()` 不会去掉字段自身的 `.default()`,会把未提交的字段也填上默认值 ——
        // 那会让「只改语言」的补丁顺带回写其它字段(并把用户的其它偏好重置)。
        // 因此这里先按未知字段校验,再**只挑出调用方真正给出的键**。
        const raw = z.record(z.string(), z.unknown()).parse(patch)
        SettingsSchema.partial().strict().parse(raw)
        const known = Object.keys(SettingsSchema.shape) as Array<keyof Settings>
        const provided: Partial<Settings> = {}
        for (const key of known) {
          if (key in raw) provided[key] = raw[key] as never
        }
        const next = await deps.settings.update(provided)
        // 原生副作用只按真正被修改的字段施加：例如切语言仅刷新托盘文案，
        // 绝不能顺带调用 macOS 的 setLoginItemSettings。
        deps.onSettingsChanged?.(next, Object.keys(provided) as Array<keyof Settings>)
        return next
      })
  )

  // **签名上没有路径参数**,并用空元组 schema 把「多传参数」判为非法调用 ——
  // 目录只能由主进程自行解析,渲染层无法指定路径(见 `shell/open-data-dir.ts`)。
  ipcMain.handle(
    SETTINGS_IPC.openDataDir,
    (_event, ...args: unknown[]): Promise<IpcResult<null>> =>
      wrap(async () => {
        z.tuple([]).parse(args)
        if (!deps.openDataDir) throw new DataDirOpenError('internal', '打开数据目录不可用')
        await deps.openDataDir()
        return null
      })
  )

  ipcMain.handle(
    HTTP_IPC.detect,
    (_event, endpointUrl: unknown): Promise<IpcResult<HttpAuthDetection>> =>
      wrap(() => {
        const raw = z.string().trim().min(1).max(2048).parse(endpointUrl)
        return detectDraftEndpoint(raw)
      })
  )

  ipcMain.handle(
    SSH_IPC.askpassReply,
    (_event, requestId: unknown, secret: unknown): Promise<IpcResult<null>> =>
      wrap(() => {
        const id = z.uuid().parse(requestId)
        // 空串不是有效口令(UI 已 disabled,IPC 边界同样拒绝)
        const value = z
          .string()
          .max(4096)
          .nullable()
          .refine((v) => v === null || v.trim() !== '', '口令不能为空串')
          .parse(secret)
        deps.prompts.replyAskpass(id, value)
        return null
      })
  )
}
