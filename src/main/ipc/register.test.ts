import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// electron 在 vitest node 环境不可加载——整体 mock 掉,只验证注册与边界行为
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: () => '9.9.9', getPath: () => '/tmp/fake-userdata' }
}))

import { ipcMain } from 'electron'
import { createInstanceStore } from '../registry/instance-store'
import { registerIpc } from './register'

type Listener = (...args: unknown[]) => unknown

const TEST_BASE = join(process.cwd(), 'hub-data', 'test-tmp')

let dir: string
let handlers: Map<string, Listener>

beforeEach(async () => {
  await mkdir(TEST_BASE, { recursive: true })
  dir = await mkdtemp(join(TEST_BASE, 'ipc-'))
  handlers = new Map()
  vi.mocked(ipcMain.handle).mockImplementation((channel, listener) => {
    handlers.set(channel as string, listener as Listener)
    return undefined as never
  })
  registerIpc(createInstanceStore({ dir }))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function invoke(channel: string, ...args: unknown[]): unknown {
  const listener = handlers.get(channel)
  if (!listener) throw new Error(`通道未注册：${channel}`)
  return listener({} as never, ...args)
}

const VALID_LOCAL = { transport: 'local', name: 'IPC 实例' }

describe('registerIpc', () => {
  it('注册 app 双探针 + 实例 CRUD 五个通道', () => {
    const expected = [
      'app:info',
      'app:ping',
      'instances:list',
      'instances:get',
      'instances:create',
      'instances:update',
      'instances:delete'
    ]
    expect([...handlers.keys()].sort()).toEqual(expected.sort())
  })

  it('app:info 返回版本快照', async () => {
    const result = (await invoke('app:info')) as { ok: boolean; value: { appVersion: string } }
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.appVersion).toBe('9.9.9')
  })

  it('app:ping 原样回显', async () => {
    const result = (await invoke('app:ping', 'hello')) as { ok: boolean; value: { echo: string | null } }
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.echo).toBe('hello')
  })

  it('create 合法输入 → ok + 完整记录', async () => {
    const result = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string; transport: string }
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(result.value.transport).toBe('local')
    }
  })

  it('create 非法输入 → 错误信封 invalid-input,不抛异常', async () => {
    const result = (await invoke('instances:create', {
      transport: 'local',
      name: 'x',
      unknownField: 1
    })) as { ok: boolean; code: string; message: string }
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('invalid-input')
      expect(result.message).toContain('unknownField')
    }
  })

  it('list 返回摘要形态(不含 notes 等详情)', async () => {
    await invoke('instances:create', { ...VALID_LOCAL, notes: '秘密备注' })
    const result = (await invoke('instances:list')) as {
      ok: boolean
      value: Array<Record<string, unknown>>
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      const summary = result.value[0]
      expect(summary).toBeDefined()
      expect(summary).not.toHaveProperty('notes')
      expect(summary).toHaveProperty('transport')
      expect(summary).toHaveProperty('authMode')
    }
  })

  it('get 非法 id → invalid-input;不存在 → ok null', async () => {
    const bad = (await invoke('instances:get', 'not-a-uuid')) as { ok: boolean; code: string }
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('invalid-input')

    const missing = (await invoke('instances:get', randomUUID())) as { ok: boolean; value: unknown }
    expect(missing.ok).toBe(true)
    if (missing.ok) expect(missing.value).toBeNull()
  })

  it('update 非法补丁 → invalid-input;不存在 → not-found', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const badPatch = (await invoke('instances:update', created.value.id, {
      port: 'x'
    })) as { ok: boolean; code: string }
    expect(badPatch.ok).toBe(false)
    expect(badPatch.code).toBe('invalid-input')

    const missingId = (await invoke('instances:update', randomUUID(), {
      name: 'x'
    })) as { ok: boolean; code: string }
    expect(missingId.ok).toBe(false)
    expect(missingId.code).toBe('not-found')
  })

  it('delete 返回 removed 标志', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const removed = (await invoke('instances:delete', created.value.id)) as {
      ok: boolean
      value: { removed: boolean }
    }
    expect(removed.ok).toBe(true)
    if (removed.ok) expect(removed.value.removed).toBe(true)

    const again = (await invoke('instances:delete', created.value.id)) as {
      ok: boolean
      value: { removed: boolean }
    }
    if (again.ok) expect(again.value.removed).toBe(false)
  })
})