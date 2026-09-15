/**
 * IPC 单点注册（T2）—— 所有 ipcMain.handle 集中于此，入参一律过 zod 边界校验。
 *
 * 设计依据：`docs/desktop-implementation-plan.md` §4 —— 渲染进程只能调用这里注册的
 * 白名单通道（preload 再暴露一层）；非法入参返回 `IpcResult` 错误信封而非抛异常，
 * 渲染层按稳定错误码映射文案（PRD §8）。
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
  SshKeyPreviewInputSchema,
  type HostKeyDecision,
  type AuthStateSnapshot,
  type HttpAuthDetection,
  type InstanceRecord,
  type InstanceSummary,
  type IpcResult
} from '@shared/contracts'
import { detectDraftEndpoint } from '../transport/http-endpoint'
import type { HttpEndpointManager } from '../transport/http-endpoint'
import { resolveSshKeyPreview } from '../ssh/key-preview'
import type { PromptBroker } from '../ssh/prompt-broker'
import type { AuthRegistry } from '../auth/auth-registry'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import type { SshTunnelManager } from '../transport/ssh-tunnel'
import { InstanceStoreError, type InstanceStore } from '../registry/instance-store'

export interface IpcDeps {
  /** 本地运行时（T3）；SSH / HTTP 传输在各自任务内接入同一状态通道 */
  runtime: LocalRuntimeManager
  /** SSH 隧道传输（T4）；HTTP 直连在 T6 */
  tunnels: SshTunnelManager
  /** 打开实例视图窗口（electron 侧实现，便于 register 单测注入假实现） */
  openInstanceView: (instance: InstanceRecord, url: string) => void
  /** T5 用户提示代理（指纹确认 / 口令输入） */
  prompts: PromptBroker
  /** T6 HTTP 直连传输 */
  http: HttpEndpointManager
  /** T8 每实例认证客户端 */
  auth: AuthRegistry
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
    // 内部错误不透传细节(可能含 fs 路径),只记主进程日志
    console.error('[ipc] 未预期错误：', error)
    return { ok: false, code: 'internal', message: '内部错误，请查看主进程日志' }
  }
}

function parseId(id: unknown): string {
  return z.uuid().parse(id)
}

function toSummary(record: InstanceRecord): InstanceSummary {
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
    updatedAt: record.updatedAt
  }
}

export function registerIpc(store: InstanceStore, deps: IpcDeps): void {
  const processVersions = process.versions as NodeJS.ProcessVersions & { electron?: string }

  // 全部通道统一返回 IpcResult 信封：错误码稳定，渲染层按码表映射文案（PRD §8）
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

  ipcMain.handle(INSTANCE_IPC.list, (): Promise<IpcResult<InstanceSummary[]>> =>
    wrap(() => store.list().then((records) => records.map(toSummary)))
  )

  ipcMain.handle(INSTANCE_IPC.get, (_event, id: unknown): Promise<IpcResult<InstanceRecord | null>> =>
    wrap(() => store.get(parseId(id)))
  )

  ipcMain.handle(INSTANCE_IPC.create, (_event, input: unknown): Promise<IpcResult<InstanceRecord>> =>
    wrap(() => store.create(CreateInstanceInputSchema.parse(input)))
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
        if (record?.transport === 'ssh') await deps.tunnels.stop(instanceId)
        else if (record?.transport === 'http') await deps.http.stop(instanceId)
        else if (record?.transport === 'local') await deps.runtime.stop(instanceId)
        return { removed: await store.remove(instanceId) }
      })
  )

  // —— 实例运行时控制（T3 本地 / T4 SSH）：start/stop 立即返回，进展经 `instance:status` 回推 ——

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
      // 契约层已限定三种 transport;此处为穷尽性兜底(TS 已收窄为 never)
      throw new InstanceStoreError('invalid-input', '未知的传输类型')
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.stop, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const record = await store.get(instanceId)
      if (record?.transport === 'ssh') await deps.tunnels.stop(instanceId)
      else if (record?.transport === 'http') await deps.http.stop(instanceId)
      else await deps.runtime.stop(instanceId) // local 或不存在:runtime.stop 幂等
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.openView, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const instance = await store.get(instanceId)
      if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)
      // 状态按 transport 取:ssh 隧道状态只存在于 tunnels 管理器,
      // local 的只在 runtime;取错管理器会让 ssh 实例「已连接但打不开视图」(评审缺陷 A)
      const status =
        instance.transport === 'ssh'
          ? deps.tunnels.statusOf(instanceId)
          : instance.transport === 'http'
            ? deps.http.statusOf(instanceId)
            : deps.runtime.statusOf(instanceId)
      if (status?.status !== 'running' || !status.url) {
        throw new InstanceStoreError('invalid-state', '实例尚未运行，无法打开视图')
      }
      deps.openInstanceView(instance, status.url)
      return null
    })
  )

  // —— SSH 辅助（T5）：密钥预览 + 指纹确认/口令回复 ——

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

  // —— 认证（T8）：状态流 + 登录提交（凭据只在主进程内存中流转） ——

  const authSnapshot = (
    state: Awaited<ReturnType<AuthRegistry['login']>>
  ): AuthStateSnapshot | null => (state === null ? null : (state as unknown as AuthStateSnapshot))

  // probe:返回状态快照(探测结论经 auth:state 事件与 T6 detect 暴露;此处主要驱动 UI 阶段)
  ipcMain.handle(AUTH_IPC.probe, (_event, id: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      await deps.auth.probe(instanceId)
      return authSnapshot(deps.auth.stateOf(instanceId) as never)
    })
  )

  ipcMain.handle(
    AUTH_IPC.login,
    (_event, id: unknown, password: unknown, otp: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const pwd = z.string().min(1).max(1024).parse(password)
        const code = z.string().max(64).nullable().parse(otp ?? null)
        return authSnapshot(await deps.auth.login(instanceId, pwd, code ?? undefined))
      })
  )

  ipcMain.handle(AUTH_IPC.logout, (_event, id: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
    wrap(async () => authSnapshot(await deps.auth.logout(parseId(id))))
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
