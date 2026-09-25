/**
 * dsh 版本通道：升级资格与更新检查、可用版本目录、触发升级与运行时确认应答。
 * 升级判定是纯逻辑，装配在 ipc-utils；停/装/重启的编排在 runtime 层。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  DSH_VERSION_IPC,
  type DshVersionCatalog,
  type DshVersionCheck,
  type IpcResult,
  type RuntimeConfirmPromptPayload
} from '@shared/contracts'
import { InstanceStoreError, type InstanceStore } from '../registry/instance-store'
import { compareDshVersions } from '../local-runtime/runtime-source'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import type { PathProbe } from '../local-runtime/runtime-source'
import type { RuntimeInstaller } from '../local-runtime/runtime-installer'
import type { PromptBroker } from '../ssh/prompt-broker'
import { parseId, upgradeEligibility, usesSystemDsh, type IpcWrap } from './ipc-utils'

export interface VersionHandlerDeps {
  runtime: LocalRuntimeManager
  pathProbe?: PathProbe
  installer?: RuntimeInstaller
  promptBroker: PromptBroker
}

export function registerVersionHandlers(store: InstanceStore, deps: VersionHandlerDeps, wrap: IpcWrap): void {
  ipcMain.handle(DSH_VERSION_IPC.check, (_event, id: unknown): Promise<IpcResult<DshVersionCheck>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const record = await store.get(instanceId)
      if (!record) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)
      if (!deps.installer) throw new InstanceStoreError('internal', 'dsh 版本管理能力不可用')
      const status = deps.runtime.statusOf(instanceId)
      let current = status?.version ?? (record.transport === 'local' ? record.dshVersion : null)
      // 'custom' 是未固定版本的占位符，不是版本号。
      if (current === 'custom') current = null
      const eligibility = upgradeEligibility(record, status?.runtimeSource)
      let reason = eligibility.reason
      // 公共空间跑系统默认 dsh：current 以 PATH 实测为准（注册表里的值不权威），并检测安装来源——
      // 缺失或非 npm 全局安装时在「检查更新」就给出不可代管原因，不等用户点了升级才失败。
      if (eligibility.canUpgrade && deps.pathProbe && usesSystemDsh(record, status?.runtimeSource)) {
        const probed = (await deps.pathProbe.probe().catch(() => null)) ?? null
        current = probed?.version ?? null
        const prefix =
          probed === null
            ? null
            : ((await deps.installer.resolveGlobalPrefix(probed.command).catch(() => null)) ?? null)
        if (prefix === null) reason = 'global-unmanaged'
      }
      const canUpgrade = reason === undefined
      const latest = await deps.installer.resolveLatestVersion()
      // 当前版本未知时：可升级的实例按「装上即最新」算有更新；来源不可知的实例不妄报。
      const hasUpdate = current !== null ? compareDshVersions(current, latest) < 0 : canUpgrade
      return { current, latest, hasUpdate, canUpgrade, ...(reason === undefined ? {} : { reason }) }
    })
  )

  ipcMain.handle(DSH_VERSION_IPC.list, (): Promise<IpcResult<DshVersionCatalog>> =>
    wrap(async () => {
      if (!deps.installer) throw new InstanceStoreError('internal', 'dsh 版本管理能力不可用')
      try {
        const [versions, installed] = await Promise.all([
          deps.installer.listAvailableVersions(),
          deps.installer.listInstalled()
        ])
        const newestFirst = (left: string, right: string): number => compareDshVersions(right, left)
        return {
          versions: [...versions].sort(newestFirst),
          installed: installed.map((item) => item.version).sort(newestFirst)
        }
      } catch (error) {
        // registry 不可达等原因：把安装器的失败原因透传给向导展示。
        throw new InstanceStoreError('internal', error instanceof Error ? error.message : String(error))
      }
    })
  )

  ipcMain.handle(DSH_VERSION_IPC.upgrade, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const record = await store.get(instanceId)
      if (!record) throw new InstanceStoreError('not-found', `实例不存在：${String(id)}`)
      const eligibility = upgradeEligibility(
        record,
        deps.runtime.statusOf(instanceId)?.runtimeSource
      )
      if (record.transport !== 'local' || !eligibility.canUpgrade) {
        throw new InstanceStoreError('invalid-input', '该实例不支持升级')
      }
      // 触发即返回：停/装/重启的编排在 runtime 层，进展经 dsh:version-progress 回推。
      void deps.runtime.upgradeInstance(record)
      return null
    })
  )

  ipcMain.handle(
    DSH_VERSION_IPC.confirmReply,
    (_event, requestId: unknown, accepted: unknown): Promise<IpcResult<null>> =>
      wrap(() => {
        const id = z.uuid().parse(requestId)
        const value = z.boolean().parse(accepted)
        deps.promptBroker.replyConfirm(id, value)
        return null
      })
  )

  ipcMain.handle(DSH_VERSION_IPC.confirmList, (): Promise<IpcResult<RuntimeConfirmPromptPayload[]>> =>
    // 快照只含 requestId/kind/版本号等非敏感字段；渲染层挂载时补拉，防止错过推送事件。
    wrap(() => deps.promptBroker.listConfirms())
  )
}
