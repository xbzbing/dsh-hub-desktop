import { describe, expect, it, vi } from 'vitest'
import {
  pendingPluginInstalls,
  subscribePluginInstalls,
  trackPluginInstall
} from './plugin-install-tracker'

/** 手动控制 settle 的任务，用于观察登记表在完成前后的状态。 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('plugin-install-tracker（后台安装在飞登记）', () => {
  it('登记后该实例可见，返回给调用方的仍是同一个 promise', async () => {
    const task = deferred<string>()
    const tracked = trackPluginInstall('install-visible', 'demo-plugin@1.1.0', task.promise)
    expect(tracked).toBe(task.promise)
    expect(pendingPluginInstalls('install-visible')).toEqual(['demo-plugin@1.1.0'])
    task.resolve('ok')
    await task.promise
  })

  it('快照稳定：内容不变返回同一引用，变化时换成冻结的新数组', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    trackPluginInstall('install-snapshot', 'b-plugin@1.0.0', first.promise)

    const one = pendingPluginInstalls('install-snapshot')
    expect(one).toEqual(['b-plugin@1.0.0'])
    expect(Object.isFrozen(one)).toBe(true)
    expect(pendingPluginInstalls('install-snapshot')).toBe(one)

    // 新增一项：排序后的内容不同，必须换一个新引用。
    trackPluginInstall('install-snapshot', 'a-plugin@1.0.0', second.promise)
    const two = pendingPluginInstalls('install-snapshot')
    expect(two).toEqual(['a-plugin@1.0.0', 'b-plugin@1.0.0'])
    expect(two).not.toBe(one)
    expect(Object.isFrozen(two)).toBe(true)
    expect(pendingPluginInstalls('install-snapshot')).toBe(two)

    first.resolve()
    second.resolve()
    await Promise.all([first.promise, second.promise])
    // 全部结束：仍是冻结数组，且同一空内容再次取用复用同一引用。
    const empty = pendingPluginInstalls('install-snapshot')
    expect(empty).toEqual([])
    expect(Object.isFrozen(empty)).toBe(true)
    expect(pendingPluginInstalls('install-snapshot')).toBe(empty)
  })

  it('settle 后清空并通知订阅者；取消订阅后不再收到通知', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribePluginInstalls(listener)
    const task = deferred<void>()
    trackPluginInstall('install-notify', 'demo-plugin@1.1.0', task.promise)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(pendingPluginInstalls('install-notify')).toHaveLength(1)

    task.resolve()
    await task.promise
    expect(pendingPluginInstalls('install-notify')).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    const next = deferred<void>()
    trackPluginInstall('install-notify', 'demo-plugin@1.2.0', next.promise)
    next.reject(new Error('boom'))
    // 调用方可能不关心结果：登记表自己吞掉这次派生链的失败，不产生未处理拒绝。
    await next.promise.catch(() => {})
    expect(listener).toHaveBeenCalledTimes(2)
    expect(pendingPluginInstalls('install-notify')).toEqual([])
  })

  it('实例隔离：一个实例的安装不出现在另一个实例的提示里', async () => {
    const task = deferred<void>()
    trackPluginInstall('install-scope-a', 'demo-plugin@1.1.0', task.promise)
    expect(pendingPluginInstalls('install-scope-a')).toEqual(['demo-plugin@1.1.0'])
    expect(pendingPluginInstalls('install-scope-b')).toEqual([])
    // 实例 id 只有前缀关系（a / ab）也不能串号。
    expect(pendingPluginInstalls('install-scope')).toEqual([])
    task.resolve()
    await task.promise
  })

  it('同 spec 旧任务结束时不会清掉新任务', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    trackPluginInstall('install-stale', 'demo-plugin@1.1.0', first.promise)
    trackPluginInstall('install-stale', 'demo-plugin@1.1.0', second.promise)

    first.resolve()
    await first.promise
    expect(pendingPluginInstalls('install-stale')).toEqual(['demo-plugin@1.1.0'])

    second.resolve()
    await second.promise
    expect(pendingPluginInstalls('install-stale')).toEqual([])
  })
})
