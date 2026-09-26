/**
 * 三种 transport 共用的实例状态总线：记录每个实例最近一次状态并发布给订阅者。
 * 不 import Electron；「单个 listener 抛错不影响其余 listener」的契约只在此处定义一份。
 */
import type { InstanceRuntimeStatus, InstanceStatusEvent } from '@shared/contracts'

export interface StatusBus {
  /** 发布一条状态并记为该实例的最近状态。 */
  emit(id: string, status: InstanceRuntimeStatus, extra?: Partial<InstanceStatusEvent>): void
  /** 订阅状态变更；返回取消订阅函数。 */
  onStatus(listener: (event: InstanceStatusEvent) => void): () => void
  /** 该实例最近一次状态；从未发布过则为 null。 */
  statusOf(id: string): InstanceStatusEvent | null
}

/**
 * @param now 时间源，各 transport 注入自己的实例以便测试固定时间戳。
 * @param tag listener 抛错时日志的来源标记，便于区分是哪条 transport 发出的。
 */
export function createStatusBus(now: () => number, tag: string): StatusBus {
  const listeners = new Set<(event: InstanceStatusEvent) => void>()
  const statuses = new Map<string, InstanceStatusEvent>()
  return {
    emit(id, status, extra = {}) {
      const event: InstanceStatusEvent = { id, status, at: new Date(now()).toISOString(), ...extra }
      statuses.set(id, event)
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (error) {
          // 只记来源与错误对象；发布方不能被订阅方拖垮
          console.error(`[${tag}] 状态监听器抛错：`, error)
        }
      }
    },
    onStatus(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    statusOf(id) {
      return statuses.get(id) ?? null
    }
  }
}
