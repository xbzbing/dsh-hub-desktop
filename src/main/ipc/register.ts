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
  PatchInstanceSchema,
  type InstanceRecord,
  type InstanceSummary,
  type IpcResult
} from '@shared/contracts'
import { InstanceStoreError, type InstanceStore } from '../registry/instance-store'

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
    return {
      ok: false,
      code: 'internal',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function parseId(id: unknown): string {
  return z.uuid().parse(id)
}

function toSummary(record: InstanceRecord): InstanceSummary {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    authMode: record.authMode,
    updatedAt: record.updatedAt
  }
}

export function registerIpc(store: InstanceStore): void {
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
      wrap(async () => ({ removed: await store.remove(parseId(id)) }))
  )
}