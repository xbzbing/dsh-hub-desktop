/**
 * 应用启动时按注册表的 `autoStart` 标记拉起本机实例。
 *
 * 「该拉起哪些」是纯选择逻辑,单独可测;「怎么拉起」复用与手动启动相同的
 * `runtime.start`,状态、失败与下载确认都走同一套状态事件。
 */
import type { InstanceRecord, LocalInstance } from '@shared/contracts'

export interface AutoStartDeps {
  list: () => Promise<InstanceRecord[]>
  start: (instance: LocalInstance) => Promise<void>
  /** 读注册表或单个实例启动失败时上报;失败不阻断其余实例的拉起。 */
  onError?: (error: unknown) => void
}

/** 勾选了「应用启动时自动拉起」的实例;该字段只存在于本机实例。 */
export function autoStartTargets(records: readonly InstanceRecord[]): LocalInstance[] {
  return records.filter(
    (record): record is LocalInstance => record.transport === 'local' && record.autoStart === true
  )
}

/**
 * 启动时拉起所有目标实例。
 *
 * 不逐个 await `start`:启动可能耗时数十秒(下载/安装运行时),
 * 彼此不该阻塞;spawn 层的串行化由 runtime 内部保证。
 */
export async function startAutoStartInstances(deps: AutoStartDeps): Promise<void> {
  let records: readonly InstanceRecord[]
  try {
    records = await deps.list()
  } catch (error) {
    deps.onError?.(error)
    return
  }
  for (const instance of autoStartTargets(records)) {
    void deps.start(instance).catch((error: unknown) => deps.onError?.(error))
  }
}
