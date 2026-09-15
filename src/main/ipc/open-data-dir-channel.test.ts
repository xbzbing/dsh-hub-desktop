import { beforeEach, describe, expect, it, vi } from 'vitest'

// electron 在 vitest node 环境不可加载——整体 mock 掉,只验证注册与边界行为
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: () => '9.9.9', getPath: () => '/tmp/fake-userdata' }
}))

import { ipcMain } from 'electron'
import { SETTINGS_IPC } from '@shared/contracts'
import { DataDirOpenError } from '../shell/open-data-dir'
import { registerIpc } from './register'
import type { IpcDeps } from './register'

/**
 * `settings:openDataDir` 通道边界测试（T11 三审 Finding 1）。
 *
 * 两条必须钉住的性质:
 * 1. **不接受任何入参** —— 打通「数据目录由主进程解析」的安全前提,
 *    多传一个参数即被空元组 schema 拒绝(invalid-input),且绝不触达打开动作;
 * 2. 失败必须变成 `{ok:false,code,message}` 信封,不是静默成功、也不是未处理 rejection。
 */

type Listener = (...args: unknown[]) => unknown
type Envelope = { ok: true; value: unknown } | { ok: false; code: string; message: string }

let handlers: Map<string, Listener>

/** 只装配本用例需要的依赖:其余通道在注册期不被读取 */
function register(openDataDir?: () => Promise<void>): void {
  handlers = new Map()
  vi.mocked(ipcMain.handle).mockImplementation((channel, listener) => {
    handlers.set(channel as string, listener as Listener)
    return undefined as never
  })
  registerIpc({} as never, { openDataDir } as unknown as IpcDeps)
}

function invoke(channel: string, ...args: unknown[]): Promise<Envelope> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`通道未注册：${channel}`)
  return Promise.resolve(handler({}, ...args) as Envelope)
}

beforeEach(() => {
  handlers = new Map()
})

describe('settings:openDataDir（打开数据目录:不接受路径参数）', () => {
  it('已注册且无入参调用成功(返回 null 信封)', async () => {
    const openDataDir = vi.fn(async () => undefined)
    register(openDataDir)

    expect(handlers.has(SETTINGS_IPC.openDataDir)).toBe(true)
    await expect(invoke(SETTINGS_IPC.openDataDir)).resolves.toEqual({ ok: true, value: null })
    expect(openDataDir).toHaveBeenCalledTimes(1)
  })

  it('多传一个路径参数 → invalid-input,且**不会**触达打开动作', async () => {
    const openDataDir = vi.fn(async () => undefined)
    register(openDataDir)

    const rejected = await invoke(SETTINGS_IPC.openDataDir, '/etc/passwd')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.code).toBe('invalid-input')
    // 关键:非法入参不会被当成路径使用
    expect(openDataDir).not.toHaveBeenCalled()
  })

  it('打开失败返回 io-error 信封(不是静默成功,也不是未处理异常)', async () => {
    register(async () => {
      throw new DataDirOpenError('io-error', 'Failed to open path')
    })
    await expect(invoke(SETTINGS_IPC.openDataDir)).resolves.toEqual({
      ok: false,
      code: 'io-error',
      message: 'Failed to open path'
    })
  })

  it('未装配打开动作 → internal 错误信封(绝不假装成功)', async () => {
    register()
    const result = await invoke(SETTINGS_IPC.openDataDir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('internal')
  })
})
