import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installTopLevelFailureLoggers } from './top-level-failure'

describe('installTopLevelFailureLoggers（顶层失败留痕）', () => {
  it('未处理拒绝按脱敏记录，不触发退出', () => {
    const target = new EventEmitter()
    const log = vi.fn()
    const exit = vi.fn()
    installTopLevelFailureLoggers({ target, log, exit })

    target.emit('unhandledRejection', new Error('打开失败 http://127.0.0.1:3080/?token=secret-x'))

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain('http://127.0.0.1:3080/')
    expect(log.mock.calls[0]?.[0]).not.toContain('token=secret-x')
    expect(exit).not.toHaveBeenCalled()
  })

  it('未捕获异常记录后以非零码退出', () => {
    const target = new EventEmitter()
    const log = vi.fn()
    const exit = vi.fn()
    installTopLevelFailureLoggers({ target, log, exit })

    target.emit('uncaughtException', new Error('状态已损坏'))

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain('状态已损坏')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('非 Error 的拒绝原因也可记录', () => {
    const target = new EventEmitter()
    const log = vi.fn()
    installTopLevelFailureLoggers({ target, log, exit: vi.fn() })

    target.emit('unhandledRejection', 'plain reason')

    expect(log.mock.calls[0]?.[0]).toContain('plain reason')
  })
})
