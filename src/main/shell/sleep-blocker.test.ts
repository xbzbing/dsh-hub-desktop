import { describe, expect, it, vi } from 'vitest'
import type { InstanceStatusEvent } from '@shared/contracts'
import { createSleepBlocker, type PowerSaveBlockerPort } from './sleep-blocker'

/** 内存版电源断言端口：真实记录 start/stop，isStarted 跟随当前持有集合。 */
function fakePort(): PowerSaveBlockerPort & { started: Set<number>; startCalls: number } {
  const started = new Set<number>()
  let next = 1
  return {
    started,
    startCalls: 0,
    start(type) {
      expect(type).toBe('prevent-app-suspension')
      this.startCalls++
      const id = next++
      started.add(id)
      return id
    },
    stop(id) {
      started.delete(id)
    },
    isStarted(id) {
      return started.has(id)
    }
  }
}

const status = (id: string, s: InstanceStatusEvent['status']): InstanceStatusEvent => ({
  id,
  status: s,
  at: '2026-01-01T00:00:00.000Z'
})

describe('sleep-blocker（有本机实例运行时阻止系统休眠）', () => {
  it('开启偏好且有实例 running 才持有断言', () => {
    const port = fakePort()
    const blocker = createSleepBlocker({ port })

    blocker.onLocalStatus(status('a', 'running'))
    expect(blocker.isActive()).toBe(false) // 偏好未开

    blocker.setEnabled(true)
    expect(blocker.isActive()).toBe(true)
    expect(port.started.size).toBe(1)
  })

  it('实例全部停止后释放断言', () => {
    const port = fakePort()
    const blocker = createSleepBlocker({ port })
    blocker.setEnabled(true)

    blocker.onLocalStatus(status('a', 'running'))
    blocker.onLocalStatus(status('b', 'running'))
    expect(blocker.isActive()).toBe(true)
    expect(port.startCalls).toBe(1) // 多个实例只持有一个断言

    blocker.onLocalStatus(status('a', 'stopped'))
    expect(blocker.isActive()).toBe(true) // b 仍在

    blocker.onLocalStatus(status('b', 'stopped'))
    expect(blocker.isActive()).toBe(false)
    expect(port.started.size).toBe(0)
  })

  it('关闭偏好立即释放，再开启且仍有实例运行则重新持有', () => {
    const port = fakePort()
    const blocker = createSleepBlocker({ port })
    blocker.setEnabled(true)
    blocker.onLocalStatus(status('a', 'running'))
    expect(blocker.isActive()).toBe(true)

    blocker.setEnabled(false)
    expect(blocker.isActive()).toBe(false)

    blocker.setEnabled(true)
    expect(blocker.isActive()).toBe(true)
  })

  it('starting/installing 不计入运行，不持有断言', () => {
    const port = fakePort()
    const blocker = createSleepBlocker({ port })
    blocker.setEnabled(true)

    blocker.onLocalStatus(status('a', 'starting'))
    blocker.onLocalStatus(status('a', 'installing'))
    expect(blocker.isActive()).toBe(false)

    blocker.onLocalStatus(status('a', 'running'))
    expect(blocker.isActive()).toBe(true)

    blocker.onLocalStatus(status('a', 'error'))
    expect(blocker.isActive()).toBe(false)
  })

  it('dispose 释放持有的断言', () => {
    const port = fakePort()
    const blocker = createSleepBlocker({ port })
    blocker.setEnabled(true)
    blocker.onLocalStatus(status('a', 'running'))
    expect(blocker.isActive()).toBe(true)

    blocker.dispose()
    expect(blocker.isActive()).toBe(false)
    expect(port.started.size).toBe(0)
  })

  it('dispose 后晚到的状态/开关不再重新持有断言（退出路径 stopAll 仍会推事件）', () => {
    const port = fakePort()
    const blocker = createSleepBlocker({ port })
    blocker.setEnabled(true)
    blocker.onLocalStatus(status('a', 'running'))
    blocker.onLocalStatus(status('b', 'running'))

    blocker.dispose()
    expect(blocker.isActive()).toBe(false)
    expect(port.started.size).toBe(0)

    // stopAll 退出清理会逐个推 stopped；dispose 后不得因残留运行集合重新 start。
    blocker.onLocalStatus(status('a', 'stopped'))
    blocker.setEnabled(true)
    blocker.onLocalStatus(status('c', 'running'))
    expect(blocker.isActive()).toBe(false)
    expect(port.started.size).toBe(0)
  })

  it('端口抛错经 onError 收敛，不冒泡', () => {
    const onError = vi.fn()
    const blocker = createSleepBlocker({
      port: {
        start: () => {
          throw new Error('boom')
        },
        stop: () => undefined,
        isStarted: () => false
      },
      onError
    })
    blocker.setEnabled(true)
    expect(() => blocker.onLocalStatus(status('a', 'running'))).not.toThrow()
    expect(onError).toHaveBeenCalledOnce()
    expect(blocker.isActive()).toBe(false)
  })
})
