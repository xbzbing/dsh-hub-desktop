import { describe, expect, it } from 'vitest'
import { pendingPluginUpgrade, trackPluginUpgrade } from './plugin-upgrade-tracker'

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

describe('plugin-upgrade-tracker（后台升级在飞登记）', () => {
  it('登记后可按实例+插件查到同一个 promise，返回给调用方的也是它', async () => {
    const task = deferred<string>()
    const tracked = trackPluginUpgrade('instance-a', 'demo-plugin', task.promise)
    expect(tracked).toBe(task.promise)
    expect(pendingPluginUpgrade('instance-a', 'demo-plugin')).toBe(task.promise)
    task.resolve('ok')
    await task.promise
  })

  it('完成后不再登记（成功与失败都一样）', async () => {
    const done = deferred<void>()
    trackPluginUpgrade('instance-a', 'demo-plugin', done.promise)
    done.resolve()
    await done.promise
    await Promise.resolve()
    expect(pendingPluginUpgrade('instance-a', 'demo-plugin')).toBeNull()

    const failed = deferred<void>()
    trackPluginUpgrade('instance-a', 'demo-plugin', failed.promise)
    failed.reject(new Error('boom'))
    // 调用方可能不关心结果：登记表自己吞掉这次派生链的失败，不产生未处理拒绝。
    await failed.promise.catch(() => {})
    await Promise.resolve()
    expect(pendingPluginUpgrade('instance-a', 'demo-plugin')).toBeNull()
  })

  it('实例与插件名任一不同都不串号', async () => {
    const task = deferred<void>()
    trackPluginUpgrade('instance-a', 'demo-plugin', task.promise)
    expect(pendingPluginUpgrade('instance-b', 'demo-plugin')).toBeNull()
    expect(pendingPluginUpgrade('instance-a', 'other-plugin')).toBeNull()
    task.resolve()
    await task.promise
  })

  it('旧任务结束时不会清掉同键的新任务', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    trackPluginUpgrade('instance-a', 'demo-plugin', first.promise)
    trackPluginUpgrade('instance-a', 'demo-plugin', second.promise)
    first.resolve()
    await first.promise
    await Promise.resolve()
    expect(pendingPluginUpgrade('instance-a', 'demo-plugin')).toBe(second.promise)
    second.resolve()
    await second.promise
  })
})
