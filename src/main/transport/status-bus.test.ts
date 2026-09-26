import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStatusBus } from './status-bus'

const AT = '2026-09-15T00:00:00.000Z'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createStatusBus', () => {
  it('emit 记为该实例的最近状态；未发布过返回 null，实例之间互不影响', () => {
    const bus = createStatusBus(() => Date.parse(AT), 'test')
    expect(bus.statusOf('a')).toBeNull()

    bus.emit('a', 'starting', { detail: '解析运行时来源' })
    expect(bus.statusOf('a')).toEqual({
      id: 'a',
      status: 'starting',
      detail: '解析运行时来源',
      at: AT
    })

    bus.emit('a', 'running')
    expect(bus.statusOf('a')).toMatchObject({ id: 'a', status: 'running', at: AT })
    expect(bus.statusOf('b')).toBeNull()
  })

  it('onStatus 收到每次发布；取消订阅后不再收到', () => {
    const bus = createStatusBus(() => Date.parse(AT), 'test')
    const first: string[] = []
    const second: string[] = []
    const unsubscribe = bus.onStatus((event) => first.push(event.status))
    bus.onStatus((event) => second.push(event.status))

    bus.emit('a', 'starting')
    unsubscribe()
    bus.emit('a', 'running')

    expect(first).toEqual(['starting'])
    expect(second).toEqual(['starting', 'running'])
  })

  it('单个 listener 抛错不影响其余 listener，也不打断发布；日志带上来源标记', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const bus = createStatusBus(() => Date.parse(AT), 'tag-for-test')
    const seen: string[] = []
    bus.onStatus(() => {
      throw new Error('listener boom')
    })
    bus.onStatus((event) => seen.push(event.status))

    expect(() => bus.emit('a', 'running')).not.toThrow()
    expect(seen).toEqual(['running'])
    expect(bus.statusOf('a')?.status).toBe('running')
    expect(spy.mock.calls[0]?.[0]).toContain('tag-for-test')
  })
})
