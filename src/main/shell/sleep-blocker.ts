/**
 * 休眠阻止：开启偏好且有本机实例处于 running 时，持有一个电源断言阻止系统空闲休眠。
 *
 * 用 `prevent-app-suspension`（macOS → PreventUserIdleSystemSleep，Windows →
 * ES_SYSTEM_REQUIRED）：只拦「空闲超时休眠」，不接管合盖与熄屏。合上笔记本盖子由系统
 * 的合盖策略决定，电源断言不覆盖它，因此满足「运行中不休眠，但合盖仍可休眠」。
 *
 * 断言的「持有/释放」是副作用，经注入端口落到 electron，决策（何时该持有）可在单测里断言。
 */
import type { InstanceStatusEvent } from '@shared/contracts'

/** 电源断言端口（生产 = electron `powerSaveBlocker`）。只用 prevent-app-suspension：
 * 拦空闲系统休眠，不接管合盖与熄屏。 */
export interface PowerSaveBlockerPort {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface SleepBlockerDeps {
  port: PowerSaveBlockerPort
  onError?(error: unknown): void
}

export interface SleepBlockerController {
  /** 本机实例状态推进（仅 local；ssh/http 不阻止系统休眠）。 */
  onLocalStatus(event: InstanceStatusEvent): void
  /** 偏好开关变化（设置页改「有本机实例运行时阻止系统休眠」时调用）。 */
  setEnabled(enabled: boolean): void
  /** 退出前释放断言。 */
  dispose(): void
  /** 当前是否持有断言。 */
  isActive(): boolean
}

/**
 * 只把 running 计入「活跃本机实例」：starting/installing 尚未对外服务，stopped/error
 * 已不再运行。断言只在「开启偏好 且 至少一个本机实例 running」时持有，其余状态组合释放。
 */
export function createSleepBlocker(deps: SleepBlockerDeps): SleepBlockerController {
  const running = new Set<string>()
  let enabled = false
  let blockerId: number | null = null
  let disposed = false

  const reconcile = (): void => {
    const shouldBlock = !disposed && enabled && running.size > 0
    try {
      if (shouldBlock && blockerId === null) {
        blockerId = deps.port.start('prevent-app-suspension')
      } else if (!shouldBlock && blockerId !== null) {
        if (deps.port.isStarted(blockerId)) deps.port.stop(blockerId)
        blockerId = null
      }
    } catch (error) {
      deps.onError?.(error)
    }
  }

  return {
    onLocalStatus(event) {
      if (event.status === 'running') running.add(event.id)
      else running.delete(event.id)
      reconcile()
    },
    setEnabled(value) {
      enabled = value
      reconcile()
    },
    dispose() {
      // 退出后 stopAll 仍会推 stopped 事件重入 reconcile；置 disposed 后任何晚到的
      // 状态/开关都不再持有断言（断言只在进程退出释放一次）。
      disposed = true
      running.clear()
      if (blockerId === null) return
      try {
        if (deps.port.isStarted(blockerId)) deps.port.stop(blockerId)
      } catch (error) {
        deps.onError?.(error)
      }
      blockerId = null
    },
    isActive: () => blockerId !== null
  }
}
