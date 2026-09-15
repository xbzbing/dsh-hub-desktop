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
import type { InstanceStatusEvent } from '@shared/contracts'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import type { SshTunnelManager } from '../transport/ssh-tunnel'
import type { HttpEndpointManager } from '../transport/http-endpoint'
import { createInstanceStore } from '../registry/instance-store'
import { registerIpc } from './register'

type Listener = (...args: unknown[]) => unknown

const TEST_BASE = join(process.cwd(), 'hub-data', 'test-tmp')

let dir: string
let handlers: Map<string, Listener>
let runtimeFake: {
  onStatus: ReturnType<typeof vi.fn>
  statusOf: ReturnType<typeof vi.fn>
  runningIds: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  stopAll: ReturnType<typeof vi.fn>
}
let tunnelsFake: {
  onStatus: ReturnType<typeof vi.fn>
  statusOf: ReturnType<typeof vi.fn>
  runningIds: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  stopAll: ReturnType<typeof vi.fn>
}
let openInstanceView: ReturnType<typeof vi.fn>
let httpFake: {
  onStatus: ReturnType<typeof vi.fn>
  statusOf: ReturnType<typeof vi.fn>
  runningIds: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  stopAll: ReturnType<typeof vi.fn>
}
let promptsFake: {
  requestHostKey: ReturnType<typeof vi.fn>
  requestAskpass: ReturnType<typeof vi.fn>
  replyHostKey: ReturnType<typeof vi.fn>
  replyAskpass: ReturnType<typeof vi.fn>
  cancelAll: ReturnType<typeof vi.fn>
}
let currentStatus: InstanceStatusEvent | null

beforeEach(async () => {
  await mkdir(TEST_BASE, { recursive: true })
  dir = await mkdtemp(join(TEST_BASE, 'ipc-'))
  handlers = new Map()
  vi.mocked(ipcMain.handle).mockImplementation((channel, listener) => {
    handlers.set(channel as string, listener as Listener)
    return undefined as never
  })
  currentStatus = null
  runtimeFake = {
    onStatus: vi.fn(() => () => undefined),
    statusOf: vi.fn(() => currentStatus),
    runningIds: vi.fn(() => []),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined)
  }
  tunnelsFake = {
    onStatus: vi.fn(() => () => undefined),
    statusOf: vi.fn(() => null),
    runningIds: vi.fn(() => []),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined)
  }
  httpFake = {
    onStatus: vi.fn(() => () => undefined),
    statusOf: vi.fn(() => null),
    runningIds: vi.fn(() => []),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined)
  }
  openInstanceView = vi.fn()
  promptsFake = {
    requestHostKey: vi.fn(async () => 'trust'),
    requestAskpass: vi.fn(async () => null),
    replyHostKey: vi.fn(() => true),
    replyAskpass: vi.fn(() => true),
    cancelAll: vi.fn()
  }
  registerIpc(createInstanceStore({ dir }), {
    runtime: runtimeFake as unknown as LocalRuntimeManager,
    tunnels: tunnelsFake as unknown as SshTunnelManager,
    http: httpFake as unknown as HttpEndpointManager,
    prompts: promptsFake as never,
    openInstanceView: openInstanceView as never
  })
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
  it('注册 app 双探针 + 实例 CRUD + 运行时控制 + T5/T6 辅助通道', () => {
    const expected = [
      'app:info',
      'app:ping',
      'instances:list',
      'instances:get',
      'instances:create',
      'instances:update',
      'instances:delete',
      'instances:start',
      'instances:stop',
      'instances:openView',
      'ssh:keyPreview',
      'ssh:hostKeyReply',
      'ssh:askpassReply',
      'http:detect'
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

  it('R3 回归:host 以 - 开头被拒(argv 选项注入面)', async () => {
    for (const host of ['-p2222', '-lroot', '-Fevil', '-oProxyCommand=evil']) {
      const result = (await invoke('instances:create', {
        transport: 'ssh',
        name: '注入尝试',
        host,
        username: 'dev'
      })) as { ok: boolean; code?: string; message?: string }
      expect(result.ok, `host=${host} 应被拒绝`).toBe(false)
      if (!result.ok) expect(result.code).toBe('invalid-input')
    }
    // 合法别名/主机仍可用
    const okHost = (await invoke('instances:create', {
      transport: 'ssh',
      name: '别名',
      host: 'build-01',
      username: 'dev'
    })) as { ok: boolean }
    expect(okHost.ok).toBe(true)
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

  it('delete:local 实例 → 先 runtime.stop 再移除记录(运行中不留孤儿进程)', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:delete', created.value.id)) as {
      ok: boolean
      value: { removed: boolean }
    }
    expect(runtimeFake.stop).toHaveBeenCalledWith(created.value.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.removed).toBe(true)
  })

  it('delete:非 local 实例不触碰运行时', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:delete', created.value.id)) as { ok: boolean }
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  // —— T3 运行时控制 ——

  it('start:local 实例 → 交给 runtime.start 并立即返回(不阻塞安装/启动)', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(runtimeFake.start).toHaveBeenCalledTimes(1)
    const record = runtimeFake.start.mock.calls[0]?.[0]
    expect(record).toMatchObject({ id: created.value.id, transport: 'local' })
  })

  it('start:http 实例 → 交给 http 管理器(T6 起 HTTP 可启动),不误触 local/ssh', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(httpFake.start).toHaveBeenCalledTimes(1)
    expect(runtimeFake.start).not.toHaveBeenCalled()
    expect(tunnelsFake.start).not.toHaveBeenCalled()
  })

  it('start:不存在的 id → not-found', async () => {
    const result = (await invoke('instances:start', randomUUID())) as { ok: boolean; code: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('not-found')
  })

  it('start:ssh 实例 → 交给 tunnels.start 并立即返回(不碰 local 运行时)', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(tunnelsFake.start).toHaveBeenCalledTimes(1)
    const record = tunnelsFake.start.mock.calls[0]?.[0]
    expect(record).toMatchObject({ id: created.value.id, transport: 'ssh' })
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('T6:http 实例 start/stop/openView 走 http 管理器', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程直连',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const startResult = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(startResult.ok).toBe(true)
    expect(httpFake.start).toHaveBeenCalledTimes(1)
    expect(runtimeFake.start).not.toHaveBeenCalled()
    expect(tunnelsFake.start).not.toHaveBeenCalled()

    httpFake.statusOf.mockReturnValue({
      id: created.value.id,
      status: 'running',
      url: 'https://gw.example.com/dsh/',
      at: '2026-09-15T00:00:00.000Z'
    })
    const openResult = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(openResult.ok).toBe(true)
    expect(openInstanceView).toHaveBeenCalledTimes(1)

    const stopResult = (await invoke('instances:stop', created.value.id)) as { ok: boolean }
    expect(stopResult.ok).toBe(true)
    expect(httpFake.stop).toHaveBeenCalledWith(created.value.id)
  })

  it('stop:ssh 实例 → tunnels.stop;local 实例 → runtime.stop', async () => {
    const ssh = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!ssh.ok) throw new Error('创建失败')
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')

    const sshStop = (await invoke('instances:stop', ssh.value.id)) as { ok: boolean }
    expect(sshStop.ok).toBe(true)
    expect(tunnelsFake.stop).toHaveBeenCalledWith(ssh.value.id)
    expect(runtimeFake.stop).not.toHaveBeenCalled()

    const localStop = (await invoke('instances:stop', local.value.id)) as { ok: boolean }
    expect(localStop.ok).toBe(true)
    expect(runtimeFake.stop).toHaveBeenCalledWith(local.value.id)
  })

  it('delete:ssh 实例 → 先 tunnels.stop 再移除;http 不触碰传输层', async () => {
    const ssh = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!ssh.ok) throw new Error('创建失败')
    const result = (await invoke('instances:delete', ssh.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(tunnelsFake.stop).toHaveBeenCalledWith(ssh.value.id)

    const http = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!http.ok) throw new Error('创建失败')
    await invoke('instances:delete', http.value.id)
    expect(tunnelsFake.stop).not.toHaveBeenCalledWith(http.value.id)
    expect(runtimeFake.stop).not.toHaveBeenCalledWith(http.value.id)
  })

  it('stop 交给 runtime.stop;openView 未运行 → invalid-state', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const stopResult = (await invoke('instances:stop', created.value.id)) as { ok: boolean }
    expect(stopResult.ok).toBe(true)
    expect(runtimeFake.stop).toHaveBeenCalledWith(created.value.id)

    const viewResult = (await invoke('instances:openView', created.value.id)) as {
      ok: boolean
      code: string
    }
    expect(viewResult.ok).toBe(false)
    if (!viewResult.ok) expect(viewResult.code).toBe('invalid-state')
  })

  it('openView:ssh 实例 running → 从 tunnels 取状态开窗(评审缺陷 A 回归)', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    tunnelsFake.statusOf.mockReturnValue({
      id: created.value.id,
      status: 'running',
      url: 'http://127.0.0.1:30000/',
      port: 30000,
      at: '2026-09-15T00:00:00.000Z'
    })
    // runtime 侧没有该实例的状态(running 只在 tunnels 里)
    currentStatus = null

    const result = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(tunnelsFake.statusOf).toHaveBeenCalledWith(created.value.id)
    expect(openInstanceView).toHaveBeenCalledTimes(1)
    expect(openInstanceView.mock.calls[0]?.[1]).toBe('http://127.0.0.1:30000/')
  })

  it('openView:运行中实例 → 用就绪 URL 打开窗口', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = {
      id: created.value.id,
      status: 'running',
      url: 'http://127.0.0.1:31234/?token=abc',
      port: 31234,
      at: '2026-09-15T00:00:00.000Z'
    }

    const result = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(openInstanceView).toHaveBeenCalledTimes(1)
    expect(openInstanceView.mock.calls[0]?.[1]).toBe('http://127.0.0.1:31234/?token=abc')
  })
})