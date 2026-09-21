/**
 *
 * 白名单通道（preload 再暴露一层）；非法入参返回 `IpcResult` 错误信封而非抛异常，
 */
import { ipcMain } from 'electron'
import type { LocalSpaceSnapshot } from '@shared/contracts'
import { z } from 'zod'
import { EndpointParseError } from '@shared/endpoint'
import { IPC } from '@shared/bridge'
import { HomepageOpenError } from '../shell/open-homepage'
import {
  AUTH_IPC,
  CreateInstanceInputSchema,
  formatZodIssues,
  INSTANCE_IPC,
  INSTANCE_RUNTIME_IPC,
  SPACE_IPC,
  PatchInstanceSchema,
  SSH_IPC,
  SshKeyPreviewInputSchema,
  VAULT_IPC,
  VaultPolicySchema,
  WorkspaceTooltipSchema,
  WorkspaceViewBoundsSchema,
  type HostKeyDecision,
  type AuthStateSnapshot,
  type ExternalDshWebSnapshot,
  type InstanceRecord,
  type VaultPolicy,
  type VaultStatusSnapshot,
  type InstanceSummary,
  type InstanceRuntimeStatus,
  type IpcResult,
  type LocalLauncherSnapshot,
  type WorkspaceViewBounds
} from '@shared/contracts'
import { httpDirectEndpoint } from '../transport/endpoint-resolver'
import { shouldReuseLoadedView } from '../webview/instance-view'
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
import type { Settings } from '@shared/settings'
import { registerHttpHandlers } from './http-handlers'
import { registerAppHandlers } from './app-handlers'
import { registerSettingsHandlers } from './settings-handlers'
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
  /** 销毁指定实例的内嵌工作区，不停止运行时或清除认证状态。 */
  closeInstanceView?: (instanceId: string) => void
  /** 主进程应用经校验的内容区边界。 */
  setInstanceViewBounds?: (bounds: WorkspaceViewBounds) => void
  /** 工作区原生视图之上的只读提示；文本与坐标由 schema 限制。 */
  showInstanceTooltip?: (tooltip: { text: string; x: number; y: number }) => Promise<void>
  hideInstanceTooltip?: () => void
  /**
   * 已缓存实例视图当前停在哪（只读）。缺省视为「无缓存视图」。
   * 用于判断本次打开是否真的会导航，从而决定认证探测要不要进入等待路径。
   */
  instanceViewUrl?: (instanceId: string) => string | null
  prompts: PromptBroker
  http: HttpEndpointManager
  auth: AuthRegistry
  clearPartitionSession?: (instanceId: string) => Promise<void>
  /** 只列出 Hub 自己管理的隔离空间；调用方不能提供路径。 */
  listLocalSpaces?: () => Promise<Array<{ id: string; sizeBytes: number; modifiedAt: string }>>
  /** 将已验证的隔离空间移至系统废纸篓；调用方不能提供路径。 */
  trashLocalSpace?: (instanceId: string) => Promise<void>
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
   * 打开项目主页。
   *
   * **签名上没有 URL 参数**——地址由装配层固定为 `HOMEPAGE_URL`,渲染层只能触发
   * 「打开」动作本身,故不可能成为任意站点 / 任意协议打开原语。
   * 缺省时该通道返回 internal 错误信封(单测不装配)。
   */
  openHomepage?: () => Promise<void>
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
    // 打开项目主页失败:同口径,不静默成功
    if (error instanceof HomepageOpenError) {
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
  const containsControl = (value: string): boolean => [...value].some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f)
  if (token === null || token === '' || containsControl(token)) {
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
    ...(record.transport === 'local' ? { useDefaultSpace: record.useDefaultSpace } : {}),
    authMode: record.authMode,
    address,
    ...(runtimeStatus ? { runtimeStatus } : {}),
    updatedAt: record.updatedAt
  }
}

export interface AuthProbeController {
  probe(instanceId: string): Promise<AuthStateSnapshot | null>
}

export function registerIpc(store: InstanceStore, deps: IpcDeps): AuthProbeController {
  /** 外部 dsh 的 token URL 仅驻留在主进程会话内，绝不进入状态流或注册表。 */
  const externalAccessUrls = new Map<string, { pid: number; port: number; url: string }>()
  const processVersions = process.versions as NodeJS.ProcessVersions & { electron?: string }
  registerAppHandlers(processVersions, wrap)

  // 关于 → 项目主页:空元组 schema 拒绝任何入参,URL 由主进程固定
  ipcMain.handle(
    IPC.openHomepage,
    (_event, ...args: unknown[]): Promise<IpcResult<null>> =>
      wrap(async () => {
        z.tuple([]).parse(args)
        if (!deps.openHomepage) throw new HomepageOpenError('internal', '打开项目主页不可用')
        await deps.openHomepage()
        return null
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

  async function localSpaces(): Promise<LocalSpaceSnapshot[]> {
    if (!deps.listLocalSpaces) throw new InstanceStoreError('invalid-state', 'local-space-unavailable')
    const records = await store.list()
    const localsById = new Map(
      records.filter((record) => record.transport === 'local').map((record) => [record.id, record.name])
    )
    return (await deps.listLocalSpaces())
      .map((space) => ({ ...space, inUse: localsById.has(space.id), instanceName: localsById.get(space.id) ?? null }))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  }

  ipcMain.handle(SPACE_IPC.list, (): Promise<IpcResult<LocalSpaceSnapshot[]>> => wrap(localSpaces))

  ipcMain.handle(SPACE_IPC.trash, (_event, id: unknown): Promise<IpcResult<{ trashed: boolean }>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const space = (await localSpaces()).find((item) => item.id === instanceId)
      if (!space) throw new InstanceStoreError('not-found', 'local-space-not-found')
      if (space.inUse) throw new InstanceStoreError('invalid-state', 'local-space-in-use')
      if (!deps.trashLocalSpace) throw new InstanceStoreError('invalid-state', 'local-space-unavailable')
      await deps.trashLocalSpace(instanceId)
      return { trashed: true }
    })
  )

  ipcMain.handle(INSTANCE_IPC.create, (_event, input: unknown): Promise<IpcResult<InstanceRecord>> =>
    wrap(async () => {
      const parsed = CreateInstanceInputSchema.parse(input)
      if (parsed.transport !== 'local') return store.create(parsed)
      if (parsed.existingSpaceId) {
        const space = (await localSpaces()).find((item) => item.id === parsed.existingSpaceId)
        if (!space) throw new InstanceStoreError('not-found', 'local-space-not-found')
        if (space.inUse) throw new InstanceStoreError('invalid-state', 'local-space-in-use')
      }
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
      try {
        await deps.vault.rememberExternalAccessToken(record.id, token)
        await deps.runtime.adopt(record, { pid: match.pid, port: match.port, patch: match.patch })
        externalAccessUrls.set(record.id, { pid: match.pid, port: match.port, url: accessUrl })
        return record
      } catch (error) {
        // 创建外部接管实例是单个用例：后续安全存储或运行时接管失败时不能留下不可见孤儿记录。
        externalAccessUrls.delete(record.id)
        await deps.runtime.stop(record.id).catch(() => undefined)
        await deps.vault.forgetExternalAccessToken(record.id).catch(() => undefined)
        await store.remove(record.id).catch(() => undefined)
        throw error
      }
    })
  )

  ipcMain.handle(
    INSTANCE_IPC.update,
    (_event, id: unknown, patch: unknown): Promise<IpcResult<InstanceRecord>> =>
      wrap(() => store.update(parseId(id), PatchInstanceSchema.parse(patch)))
  )

  ipcMain.handle(
    INSTANCE_IPC.delete,
    (_event, id: unknown, options: unknown): Promise<IpcResult<{ removed: boolean }>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const deleteOptions = z.object({ trashSpace: z.boolean().default(false) }).strict().parse(options ?? {})
        // 详情页文案承诺「删除运行中的实例会先停止其进程」:先回收进程树再移除记录,
        // 否则 dsh/ssh 进程继续存活(独占端口与 DSH_HOME),窗口也无 stopped 事件可回收
        const record = await store.get(instanceId)
        externalAccessUrls.delete(instanceId)
        await deps.vault.forgetExternalAccessToken(instanceId)
        if (record?.transport === 'ssh') await deps.tunnels.stop(instanceId)
        else if (record?.transport === 'http') await deps.http.stop(instanceId)
        else if (record?.transport === 'local') await deps.runtime.stop(instanceId)
        if (deleteOptions.trashSpace && record?.transport === 'local' && !record.useDefaultSpace) {
          if (!deps.trashLocalSpace) throw new InstanceStoreError('invalid-state', 'local-space-unavailable')
          await deps.trashLocalSpace(instanceId)
        }
        deps.hideInstanceView?.()
        deps.auth.forget(instanceId)
        await deps.vault.forgetInstance(instanceId)
        await deps.clearPartitionSession?.(instanceId).catch(() => undefined)
        return { removed: await store.remove(instanceId) }
      })
  )

  ipcMain.handle(
    INSTANCE_IPC.reorder,
    (_event, orderedIds: unknown): Promise<IpcResult<InstanceSummary[]>> =>
      wrap(async () => {
        if (!Array.isArray(orderedIds)) {
          throw new InstanceStoreError('invalid-input', '排序列表必须是字符串数组')
        }
        const ids = orderedIds.map((id) => parseId(id))
        const records = await store.reorder(ids)
        return records.map((record) => toSummary(record, statusFor(record)))
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

  ipcMain.handle(INSTANCE_RUNTIME_IPC.restart, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const instance = await store.get(instanceId)
      if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)
      if (instance.transport !== 'local') {
        throw new InstanceStoreError('invalid-input', '只有本机实例支持重启')
      }
      // 外部接管的进程归用户所有,hub 无权重启;未运行的实例没有进程可重启。
      const status = deps.runtime.statusOf(instanceId)
      if (!status || status.status !== 'running') {
        throw new InstanceStoreError('invalid-state', '实例未在运行，无法重启')
      }
      if (status.runtimeSource === 'external') {
        throw new InstanceStoreError('invalid-state', '外部接管的 dsh 进程归用户所有，不能由 hub 重启')
      }
      // 先完全停止（等待进程退出并发出 stopped），再按当前注册表配置重新拉起。
      // 重启可能分配新端口/新 browser-auth URL：启动耗时较长，不 await，
      // 进展与失败都经状态事件回推，渲染层据 running 事件重开工作区。
      await deps.runtime.stop(instanceId)
      void deps.runtime.start(instance)
      return null
    })
  )

  const openViewTasks = new Map<string, Promise<void>>()
  let workspaceTargetId: string | null = null

  async function openWorkspace(instanceId: string): Promise<void> {
    // 同实例的并发请求合并；不同实例则只有最新目标可以激活原生视图。
    const isCurrent = (): boolean => workspaceTargetId === instanceId
    const openIfCurrent = async (instance: InstanceRecord, url: string): Promise<void> => {
      if (!isCurrent()) return
      // 首次打开不能依赖详情页的异步 probe：它可能晚于 WebContentsView 的首个导航，
      // 导致已记住的会话 Cookie 还没恢复就先被网关重定向到 /login。
      // 但已经停在同一 URL 的缓存视图不会再导航（见 shouldReuseLoadedView），
      // 此时注入 Cookie 无从发生，等待一次远程网关往返只会拖长切换的加载时间。
      if (instance.authMode !== 'none') {
        const probe = probeWithStoredPassword(instance.id)
        const cachedUrl = deps.instanceViewUrl?.(instance.id) ?? undefined
        if (shouldReuseLoadedView(cachedUrl, url)) {
          void probe.catch((error: unknown) => console.error('[register] 后台认证探测失败：', error))
        } else {
          await probe
        }
      }
      if (isCurrent()) await deps.openInstanceView(instance, url)
    }
    const instance = await store.get(instanceId)
    if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${instanceId}`)
    const status =
      instance.transport === 'ssh'
        ? deps.tunnels.statusOf(instanceId)
        : instance.transport === 'http'
          ? deps.http.statusOf(instanceId)
          : deps.runtime.statusOf(instanceId)
    if (status?.status === 'running' && !(instance.transport === 'local' && status.runtimeSource === 'external')) {
      const url = instance.transport === 'local' ? deps.runtime.urlOf(instanceId) : status.url
      if (!url) throw new Error('workspace-url-unavailable')
      await openIfCurrent(instance, url)
      return
    }
    if (instance.transport === 'http') {
      if (status?.status !== 'starting') {
        void deps.http.start(instance).catch((error: unknown) => {
          console.error('[register] HTTP 实例状态探测失败：', error)
        })
      }
      await openIfCurrent(instance, httpDirectEndpoint(instance))
      return
    }
    if (instance.transport === 'ssh') {
      await deps.tunnels.start(instance)
      const ready = deps.tunnels.statusOf(instanceId)
      if (ready?.status === 'running' && ready.url) {
        await openIfCurrent(instance, ready.url)
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
          await deps.runtime.stop(instanceId)
          await deps.vault.forgetExternalAccessToken(instanceId)
          throw new InstanceStoreError('invalid-state', '本机 dsh 已重启，请在实例详情中更新访问 token')
        }
        await openIfCurrent(instance, savedAccess.url)
        return
      }
      const external = deps.externalDsh ? await deps.externalDsh.scan() : []
      const match = external.find((item) => item.port === instance.port)
      if (match && match.port !== null) {
        const token = deps.vault.getExternalAccessToken(instanceId)
        if (!token) {
          throw new InstanceStoreError('invalid-state', '本机 dsh 需要访问 token，请在实例详情中更新')
        }
        const accessUrl = externalAccessUrl(token, match.port)
        if (!(await (deps.verifyExternalAccess ?? defaultVerifyExternalAccess)(accessUrl))) {
          await deps.vault.forgetExternalAccessToken(instanceId)
          throw new InstanceStoreError('invalid-state', '本机 dsh 的访问 token 已失效，请在实例详情中更新')
        }
        await deps.runtime.adopt(instance, { pid: match.pid, port: match.port, patch: match.patch })
        externalAccessUrls.set(instanceId, { pid: match.pid, port: match.port, url: accessUrl })
        await openIfCurrent(instance, accessUrl)
        return
      }
      await deps.runtime.start(instance)
      const ready = deps.runtime.statusOf(instanceId)
      const url = deps.runtime.urlOf(instanceId)
      if (ready?.status === 'running' && url) {
        await openIfCurrent(instance, url)
      }
      return
    }
    throw new InstanceStoreError('invalid-input', '未知的传输类型')
  }

  ipcMain.handle(INSTANCE_RUNTIME_IPC.openView, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      workspaceTargetId = instanceId
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

  ipcMain.handle(INSTANCE_RUNTIME_IPC.probeLocalDsh, (): Promise<IpcResult<LocalLauncherSnapshot[]>> =>
    wrap(async () => {
      const launchers = await Promise.all(
        (['dsh', 'dush'] as const).map(async (launcher) => {
          const found = deps.pathProbe?.probeLauncher
            ? await deps.pathProbe.probeLauncher(launcher)
            : launcher === 'dsh'
              ? await deps.pathProbe?.probe()
              : null
          return found ? { launcher, version: found.version } : null
        })
      )
      return launchers.filter((snapshot): snapshot is LocalLauncherSnapshot => snapshot !== null)
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
        const previousAccess = externalAccessUrls.get(instanceId)
        const previousToken = deps.vault.getExternalAccessToken(instanceId)
        const currentRuntime = deps.runtime.statusOf(instanceId)
        const replacingExternal = deps.runtime.runningIds().includes(instanceId)
        if (replacingExternal && currentRuntime?.runtimeSource !== 'external') {
          throw new InstanceStoreError('invalid-state', '实例已在运行，不能接管其他本机 dsh web')
        }
        const rawAccess = typeof access === 'string' ? access.trim() : ''
        const usingStoredToken = rawAccess === ''
        const token = usingStoredToken
          ? previousToken
          : externalAccessToken(access, match.port)
        if (!token) throw new InstanceStoreError('invalid-state', '本机 dsh 需要访问 token，请在实例详情中更新')
        const accessUrl = externalAccessUrl(token, match.port)
        if (!(await (deps.verifyExternalAccess ?? defaultVerifyExternalAccess)(accessUrl))) {
          if (usingStoredToken) await deps.vault.forgetExternalAccessToken(instanceId)
          throw new InstanceStoreError('invalid-state', '访问 token 无效，请重新输入')
        }
        // 先持久化新 token，再拆除旧接管；持久化失败时当前可用会话完全不受影响。
        if (!usingStoredToken) await deps.vault.rememberExternalAccessToken(instanceId, token)
        try {
          if (replacingExternal) await deps.runtime.stop(instanceId)
          await deps.runtime.adopt(instance, {
            pid: match.pid,
            port: match.port,
            patch: match.patch
          })
          externalAccessUrls.set(instanceId, { pid: match.pid, port: match.port, url: accessUrl })
        } catch (error) {
          externalAccessUrls.delete(instanceId)
          await deps.runtime.stop(instanceId).catch(() => undefined)
          // 恢复旧 token 与已接管的用户进程，避免失败操作毁掉先前可用的会话。
          if (!usingStoredToken) {
            if (previousToken) await deps.vault.rememberExternalAccessToken(instanceId, previousToken).catch(() => undefined)
            else await deps.vault.forgetExternalAccessToken(instanceId).catch(() => undefined)
          }
          if (previousAccess) {
            await deps.runtime
              .adopt(instance, {
                pid: previousAccess.pid,
                port: previousAccess.port,
                patch: null,
                url: previousAccess.url
              })
              .catch(() => undefined)
            externalAccessUrls.set(instanceId, previousAccess)
          }
          throw error
        }
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

  ipcMain.handle(INSTANCE_RUNTIME_IPC.showTooltip, (_event, tooltip: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const parsed = WorkspaceTooltipSchema.parse(tooltip)
      await deps.showInstanceTooltip?.(parsed)
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.hideTooltip, (): Promise<IpcResult<null>> =>
    wrap(() => {
      deps.hideInstanceTooltip?.()
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.hideView, (): Promise<IpcResult<null>> =>
    wrap(() => {
      // 任何隐藏操作都取消尚未完成的 openView，防止迟到请求重新激活原生视图。
      workspaceTargetId = null
      deps.hideInstanceTooltip?.()
      deps.hideInstanceView?.()
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.disconnectView, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const instance = await store.get(instanceId)
      if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${instanceId}`)
      if (workspaceTargetId === instanceId) workspaceTargetId = null
      deps.hideInstanceTooltip?.()
      deps.closeInstanceView?.(instanceId)
      return null
    })
  )

  const authSnapshot = (state: Awaited<ReturnType<AuthRegistry['login']>>): AuthStateSnapshot | null => state

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

  /**
   * 主进程自行读取。门禁:策略允许记住密码且 vault 里确有该实例的密码,
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

  async function probeWithStoredPassword(instanceId: string): Promise<AuthStateSnapshot | null> {
    const beforeProbe = deps.auth.stateOf(instanceId)
    await deps.auth.probe(instanceId)
    const probedState = deps.auth.stateOf(instanceId) as Awaited<ReturnType<AuthRegistry['stateOf']>>
    // 远端 dsh 重启会让原有 Cookie 失效：允许这次从 connected 回落到登录态时重新复用一次已存密码。
    if (beforeProbe?.phase === 'connected' && probedState?.phase !== 'connected') {
      storedLoginAttempted.delete(instanceId)
    }
    const state = await autoLoginWithStored(instanceId, probedState)
    return authSnapshot(state)
  }

  // Try one silent login when probing finds a stored password and an authentication state.
  ipcMain.handle(AUTH_IPC.probe, (_event, id: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
    wrap(async () => probeWithStoredPassword(parseId(id)))
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

  // 策略允许且 vault 里确有密码，否则 invalid-input；密码不跨 IPC。
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
      // 登出时忘掉 vault 中的会话:否则重启后 restoreSessionFromVault 会恢复已失效的登录态
      await deps.vault.forgetSession(instanceId).catch(() => undefined)
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

  registerSettingsHandlers(
    {
      settings: deps.settings,
      onSettingsChanged: deps.onSettingsChanged,
      openDataDir: deps.openDataDir
    },
    wrap
  )

  registerHttpHandlers(wrap)

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

  return { probe: probeWithStoredPassword }
}
