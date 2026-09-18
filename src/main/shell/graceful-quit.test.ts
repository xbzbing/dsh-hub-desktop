import { describe, expect, it, vi } from 'vitest'
import { createGracefulQuit } from './graceful-quit'

describe('createGracefulQuit', () => {
  it('第一次退出等待清理完成后以 exit 完成进程退出', async () => {
    let resolveCleanup!: () => void
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve
        })
    )
    const exit = vi.fn()
    const quit = createGracefulQuit({ cleanup, exit })
    const event = { preventDefault: vi.fn() }

    quit.handleBeforeQuit(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()

    resolveCleanup()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })

  it('重复退出事件不重新启动清理，也不要求用户再次触发退出', async () => {
    const cleanup = vi.fn(async () => undefined)
    const exit = vi.fn()
    const quit = createGracefulQuit({ cleanup, exit })

    quit.handleBeforeQuit({ preventDefault: vi.fn() })
    quit.handleBeforeQuit({ preventDefault: vi.fn() })

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})
