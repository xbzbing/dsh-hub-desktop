import { beforeEach, describe, expect, it, vi } from 'vitest'

// electron 在 vitest node 环境不可加载——整体 mock 掉,只验证注册与边界行为
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: () => '9.9.9', getPath: () => '/tmp/fake-userdata' }
}))

import { ipcMain } from 'electron'
import { IPC } from '@shared/bridge'
import { HomepageOpenError } from '../shell/open-homepage'
import { registerIpc } from './register'
import type { IpcDeps } from './register'

/**
 * `app:open-homepage` 的边界:
 * 1. **不接受任何入参** —— URL 由主进程固定为项目主页,渲染层传不了目标站点
 *    (多传一个参数即被空元组 schema 拒绝,且绝不触达打开动作);
 * 2. 失败必须变成 `{ok:false,code,message}` 信封,不是静默成功、也不是未处理 rejection。
 */

type Listener = (...args: unknown[]) => unknown
type Envelope = { ok: true; value: unknown } | { ok: false; code: string; message: string }

let handlers: Map<string, Listener>

/** 只装配本用例需要的依赖:其余通道在注册期不被读取 */
function register(openHomepage?: () => Promise<void>): void {
  handlers = new Map()
  vi.mocked(ipcMain.handle).mockImplementation((channel, listener) => {
    handlers.set(channel as string, listener as Listener)
    return undefined as never
  })
  registerIpc({} as never, { openHomepage } as unknown as IpcDeps)
}

function invoke(channel: string, ...args: unknown[]): Promise<Envelope> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`通道未注册：${channel}`)
  return Promise.resolve(handler({}, ...args) as Envelope)
}

beforeEach(() => {
  handlers = new Map()
})

describe('app:open-homepage（打开项目主页:不接受 URL 参数）', () => {
  it('已注册且无入参调用成功(返回 null 信封)', async () => {
    const openHomepage = vi.fn(async () => undefined)
    register(openHomepage)

    expect(handlers.has(IPC.openHomepage)).toBe(true)
    await expect(invoke(IPC.openHomepage)).resolves.toEqual({ ok: true, value: null })
    expect(openHomepage).toHaveBeenCalledTimes(1)
  })

  it('多传一个 URL 参数 → invalid-input,且**不会**触达打开动作', async () => {
    const openHomepage = vi.fn(async () => undefined)
    register(openHomepage)

    const rejected = await invoke(IPC.openHomepage, 'https://example.com')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.code).toBe('invalid-input')
    // 关键:渲染层无法借这个通道打开任意站点
    expect(openHomepage).not.toHaveBeenCalled()
  })

  it('打开失败返回 io-error 信封(不是静默成功,也不是未处理异常)', async () => {
    register(async () => {
      throw new HomepageOpenError('io-error', 'Failed to open external url')
    })
    await expect(invoke(IPC.openHomepage)).resolves.toEqual({
      ok: false,
      code: 'io-error',
      message: 'Failed to open external url'
    })
  })

  it('未装配打开动作 → internal 错误信封(绝不假装成功)', async () => {
    register()
    const result = await invoke(IPC.openHomepage)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('internal')
  })
})
