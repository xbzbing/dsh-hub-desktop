/**
 * IPC 单点注册（T2）—— 所有 ipcMain.handle 集中于此，入参一律过 zod 边界校验。
 *
 * 设计依据：`docs/desktop-implementation-plan.md` §4 —— 渲染进程只能调用这里注册的
 * 白名单通道（preload 再暴露一层）；非法入参返回 `IpcResult` 错误信封而非抛异常，
 * 渲染层按稳定错误码映射文案（PRD §8）。
 */
import { app, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC, type AppInfo, type PingResult } from '@shared/bridge'
import {
  CreateInstanceInputSchema,
  formatZodIssues,
  INSTANCE_IPC,
  INSTANCE_RUNTIME_IPC,
  PatchInstanceSchema,
  type InstanceRecord,
  type InstanceSummary,
  type IpcResult
} from '@shared/contracts'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import { InstanceStoreError, type InstanceStore } from '../registry/instance-store'

export interface IpcDeps {
  /** 本地运行时（T3）；SSH / HTTP 传输在各自任务内接入同一状态通道 */
  runtime: LocalRuntimeManager
  /** 打开实例视图窗口（electron 侧实现，便于 register 单测注入假实现） */
  openInstanceView: (instance: InstanceRecord, url: string) => void
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
        // 否则 dsh 进程继续存活(独占端口与 DSH_HOME),实例窗口也无 stopped 事件可回收
        const record = await store.get(instanceId)
        if (record?.transport === 'local') await deps.runtime.stop(instanceId)
        return { removed: await store.remove(instanceId) }
      })
  )

  // —— 本地运行时控制（T3）：start/stop 立即返回，进展经 `instance:status` 事件回推 ——

  ipcMain.handle(INSTANCE_RUNTIME_IPC.start, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instance = await store.get(parseId(id))
      if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)
      if (instance.transport !== 'local') {
        throw new InstanceStoreError('invalid-input', '本机启动仅适用于 local 传输实例')
      }
      // 不 await：安装/启动可能耗时数十秒，进展与失败都走状态事件
      void deps.runtime.start(instance)
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.stop, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      await deps.runtime.stop(parseId(id))
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.openView, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const instance = await store.get(instanceId)
      if (!instance) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)
      const status = deps.runtime.statusOf(instanceId)
      if (status?.status !== 'running' || !status.url) {
        throw new InstanceStoreError('invalid-state', '实例尚未运行，无法打开视图')
      }
      deps.openInstanceView(instance, status.url)
      return null
    })
  )
}