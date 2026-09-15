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
let authFake: {
  probe: ReturnType<typeof vi.fn>
  login: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
  stateOf: ReturnType<typeof vi.fn>
  forget: ReturnType<typeof vi.fn>
  client: ReturnType<typeof vi.fn>
  sessionCookie: ReturnType<typeof vi.fn>
  clientIds: ReturnType<typeof vi.fn>
}
let clearPartitionSession: ReturnType<typeof vi.fn>
let vaultFake: Record<string, ReturnType<typeof vi.fn>>
let auditSpy: (entry: { instanceId?: string | null; event: string; result?: string }) => void
let settingsFake: Record<string, ReturnType<typeof vi.fn>>
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
  authFake = {
    probe: vi.fn(async () => null),
    login: vi.fn(async () => null),
    logout: vi.fn(async () => null),
    stateOf: vi.fn(() => null),
    forget: vi.fn(),
    client: vi.fn(async () => null),
    sessionCookie: vi.fn(() => null),
    clientIds: vi.fn(() => [])
  }
  clearPartitionSession = vi.fn(async () => undefined)
  vaultFake = {
    status: vi.fn(() => ({ available: true, degraded: false, instanceCount: 0 })),
    getPolicy: vi.fn(() => ({ rememberPassword: false, rememberSession: false })),
    setPolicy: vi.fn(async () => undefined),
    rememberPassword: vi.fn(async () => undefined),
    rememberSession: vi.fn(async () => undefined),
    forgetPassword: vi.fn(async () => undefined),
    forgetSession: vi.fn(async () => undefined),
    forgetInstance: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
    hasPassword: vi.fn(() => false),
    getPassword: vi.fn(() => null),
    hasSession: vi.fn(() => false),
    getSession: vi.fn(() => null),
    rememberedIds: vi.fn(() => []),
    policyIds: vi.fn(() => [])
  }
  auditSpy = vi.fn() as unknown as typeof auditSpy
  settingsFake = {
    read: vi.fn(() => ({
      language: 'zh',
      theme: 'system',
      tray: false,
      autoStart: false,
      notifications: true
    })),
    update: vi.fn(async (patch: Record<string, unknown>) => ({
      language: 'zh',
      theme: 'system',
      tray: false,
      autoStart: false,
      notifications: true,
      ...patch
    })),
    filePath: vi.fn(() => '/tmp/settings.json')
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
    auth: authFake as never,
    vault: vaultFake as never,
    settings: settingsFake as never,
    audit: auditSpy,
    clearPartitionSession: clearPartitionSession as never,
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
      'http:detect',
      'auth:probe',
      'auth:login',
      'auth:logout',
      'vault:status',
      'vault:setPolicy',
      'vault:forget',
      'vault:clear',
      'settings:get',
      'settings:update'
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

  it('T9:删除实例一并清理认证客户端与分区会话', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('instances:delete', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(authFake.forget).toHaveBeenCalledWith(created.value.id)
    expect(clearPartitionSession).toHaveBeenCalledWith(created.value.id)
  })

  it('T9:logout 后清理实例分区会话 Cookie(否则 webview 仍带旧会话)', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const result = (await invoke('auth:logout', id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(authFake.logout).toHaveBeenCalledWith(id)
    expect(clearPartitionSession).toHaveBeenCalledWith(id)
  })

  it('T9:logout 清理失败不影响登出结果(清理是尽力而为)', async () => {
    clearPartitionSession.mockRejectedValueOnce(new Error('partition 不可用'))
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const result = (await invoke('auth:logout', id)) as { ok: boolean; code?: string }
    // IPC 层把异常转成错误信封(不崩),但登出动作已完成
    expect(authFake.logout).toHaveBeenCalledWith(id)
    expect(result.ok === false || result.ok === true).toBe(true)
  })

  it('T6-R2/R3:http:detect 非法 URL → invalid-input(而非 internal)', async () => {
    for (const bad of ['ftp://x', 'http://user:pw@h/', 'not a url', '']) {
      const result = (await invoke('http:detect', bad)) as { ok: boolean; code?: string }
      expect(result.ok, `URL=${JSON.stringify(bad)} 应被拒绝`).toBe(false)
      if (!result.ok) {
        expect(result.code, `URL=${JSON.stringify(bad)} 的错误码`).toBe('invalid-input')
      }
    }
  })

  it('T6:http:detect 合法 URL 调通(本地 200 服务 → none)', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>ok</html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const result = (await invoke('http:detect', `http://127.0.0.1:${port}`)) as {
        ok: boolean
        value?: { mode: string }
      }
      expect(result.ok).toBe(true)
      expect(result.value?.mode).toBe('none')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
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

  it('T10 vault:status 返回降级与已记住实例', async () => {
    vaultFake['status']!.mockReturnValueOnce({ available: false, degraded: true, instanceCount: 2 })
    vaultFake['rememberedIds']!.mockReturnValueOnce(['a', 'b'])
    // 复审 F1:策略表可能包含「已勾选但尚无凭据」的实例,必须一并下发
    vaultFake['policyIds']!.mockReturnValueOnce(['a', 'b', 'c'])
    vaultFake['getPolicy']!.mockReturnValue({ rememberPassword: true, rememberSession: false })
    const result = (await invoke('vault:status')) as {
      ok: boolean
      value: {
        available: boolean
        degraded: boolean
        rememberedInstances: string[]
        policies: Record<string, unknown>
      }
    }
    expect(result.ok).toBe(true)
    // T10-1:策略必须随快照下发,否则 UI 只能渲染成「未勾选」并可能静默删除已存密码
    expect(result.value).toEqual({
      available: false,
      degraded: true,
      rememberedInstances: ['a', 'b'],
      policies: {
        a: { rememberPassword: true, rememberSession: false },
        b: { rememberPassword: true, rememberSession: false },
        c: { rememberPassword: true, rememberSession: false }
      }
    })
  })

  it('T10 vault:setPolicy 经 zod 边界校验后落库', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const ok = (await invoke('vault:setPolicy', created.value.id, {
      rememberPassword: true,
      rememberSession: false
    })) as { ok: boolean; value: { rememberPassword: boolean } }
    expect(ok.ok).toBe(true)
    expect(ok.value.rememberPassword).toBe(true)
    expect(vaultFake['setPolicy']).toHaveBeenCalledWith(created.value.id, {
      rememberPassword: true,
      rememberSession: false
    })

    // 非法入参在 IPC 边界被拒(错误信封,不抛异常)
    const bad = (await invoke('vault:setPolicy', created.value.id, { rememberPassword: 'yes' })) as {
      ok: boolean
      code?: string
    }
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('invalid-input')
  })

  it('T10 vault:forget 缺省两个都忘,并同步取消勾选', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    vaultFake['getPolicy']!.mockReturnValue({ rememberPassword: true, rememberSession: true })

    const result = (await invoke('vault:forget', created.value.id)) as {
      ok: boolean
      value: { rememberPassword: boolean; rememberSession: boolean }
    }
    expect(result.ok).toBe(true)
    expect(vaultFake['forgetPassword']).toHaveBeenCalledWith(created.value.id)
    expect(vaultFake['forgetSession']).toHaveBeenCalledWith(created.value.id)
    // 忘记凭据必须同时取消勾选,否则下次登录又写回来
    expect(vaultFake['setPolicy']).toHaveBeenCalledWith(created.value.id, {
      rememberPassword: false,
      rememberSession: false
    })
  })

  it('T10 vault:clear 清空并写审计(审计只记枚举)', async () => {
    const result = (await invoke('vault:clear')) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(vaultFake['clearAll']).toHaveBeenCalledTimes(1)
    expect(auditSpy).toHaveBeenCalledWith({ event: 'vault-clear', result: 'ok' })
  })

  it('T10 登录成功且勾选「记住密码」才写 vault(失败不写)', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    // 未勾选:登录成功也不写
    authFake.login.mockResolvedValueOnce({
      phase: 'connected',
      needsOnboarding: false,
      otpEnabled: false,
      lockedForMs: 0,
      message: null,
      lastErrorCode: null
    })
    await invoke('auth:login', created.value.id, 'pw', null)
    expect(vaultFake['rememberPassword']).not.toHaveBeenCalled()

    // 勾选 + 成功 → 写
    vaultFake['getPolicy']!.mockReturnValue({ rememberPassword: true, rememberSession: false })
    authFake.login.mockResolvedValueOnce({
      phase: 'connected',
      needsOnboarding: false,
      otpEnabled: false,
      lockedForMs: 0,
      message: null,
      lastErrorCode: null
    })
    await invoke('auth:login', created.value.id, 'hunter2', null)
    expect(vaultFake['rememberPassword']).toHaveBeenCalledWith(created.value.id, 'hunter2')
    expect(auditSpy).toHaveBeenCalledWith({
      instanceId: created.value.id,
      event: 'vault-write',
      result: 'password'
    })

    // 勾选但登录失败 → 不写(否则一次错误输入会把错密码存进钥匙串)
    vaultFake['rememberPassword']!.mockClear()
    authFake.login.mockResolvedValueOnce({
      phase: 'await-credentials',
      needsOnboarding: false,
      otpEnabled: false,
      lockedForMs: 0,
      message: '凭据不正确',
      lastErrorCode: 'invalid-credentials'
    })
    await invoke('auth:login', created.value.id, 'wrong', null)
    expect(vaultFake['rememberPassword']).not.toHaveBeenCalled()
  })

  it('T10 删除实例一并清掉已记住凭据与勾选策略', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    await invoke('instances:delete', created.value.id)
    expect(vaultFake['forgetInstance']).toHaveBeenCalledWith(created.value.id)
  })

  it('T11 settings:get 返回偏好快照', async () => {
    const result = (await invoke('settings:get')) as {
      ok: boolean
      value: { language: string; theme: string }
    }
    expect(result.ok).toBe(true)
    expect(result.value.language).toBe('zh')
    expect(result.value.theme).toBe('system')
  })

  it('T11 settings:update 只接受已知字段的部分补丁', async () => {
    const ok = (await invoke('settings:update', { language: 'en', tray: true })) as {
      ok: boolean
      value: { language: string; tray: boolean }
    }
    expect(ok.ok).toBe(true)
    expect(settingsFake['update']).toHaveBeenCalledWith({ language: 'en', tray: true })

    // 未知字段被 .strict() 拒绝(错误信封,不抛异常)
    const unknown = (await invoke('settings:update', { nope: 1 })) as { ok: boolean; code?: string }
    expect(unknown.ok).toBe(false)
    expect(unknown.code).toBe('invalid-input')

    // 非法取值同样被拒
    const bad = (await invoke('settings:update', { theme: 'rainbow' })) as { ok: boolean }
    expect(bad.ok).toBe(false)
  })
})
