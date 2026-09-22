import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { InstanceStatusEvent, LocalInstance } from '@shared/contracts'
import type { RuntimeInstaller } from './runtime-installer'
import {
  createLocalRuntime,
  type LocalRuntimeManager,
  type SpawnInvocation,
  type SpawnedProcess
} from './local-runtime'

const ISO = '2026-09-15T00:00:00.000Z'

function localInstance(overrides: Partial<LocalInstance> = {}): LocalInstance {
  return {
    id: randomUUID(),
    name: '测试实例',
    transport: 'local',
    authMode: 'auto',
    dshVersion: null,
    port: null,
    profile: null,
    launcher: null,
    useDefaultSpace: false,
    autoStart: false,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  }
}

interface FakeChild extends SpawnedProcess {
  stdout: PassThrough
  stderr: PassThrough
  emit(event: string, ...args: unknown[]): boolean
  listeners(event: string): unknown[]
  killCall: NodeJS.Signals[]
}

function makeFakeInstaller(overrides: Partial<RuntimeInstaller> = {}): RuntimeInstaller & {
  install: ReturnType<typeof vi.fn>
  ensureInstalled: ReturnType<typeof vi.fn>
} {
  const installed = (): {
    version: string
    dir: string
    entry: string
    installedAt: string
  } => ({
    version: '0.1.5-rc.1',
    dir: '/tmp/runtimes/dsh-0.1.5-rc.1',
    entry: '/tmp/runtimes/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js',
    installedAt: ISO
  })
  const base: RuntimeInstaller = {
    listAvailableVersions: async () => ['0.1.5-rc.1'],
    resolveDefaultVersion: async () => '0.1.5-rc.1',
    resolveLatestVersion: async () => '0.1.5-rc.1',
    listInstalled: async () => [],
    isInstalled: async (version) => version === '0.1.5-rc.1',
    install: vi.fn(async () => installed()),
    ensureInstalled: vi.fn(async () => installed()),
    resolveEntry: (version) => `/tmp/runtimes/dsh-${version}/lib/bin.js`,
    hasIncompleteInstall: async () => false,
    ...overrides
  }
  return base as RuntimeInstaller & {
    install: ReturnType<typeof vi.fn>
    ensureInstalled: ReturnType<typeof vi.fn>
  }
}

/** 等待某状态出现(轮询,默认 2s 上限) */
async function waitForStatus(
  manager: LocalRuntimeManager,
  id: string,
  status: InstanceStatusEvent['status'],
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (manager.statusOf(id)?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待状态 ${status} 超时（当前：${manager.statusOf(id)?.status}）`)
}

function readyLine(port = 31234): string {
  return `dsh web: http://127.0.0.1:${port}/?token=test-token\n`
}

describe('createLocalRuntime', () => {
  it('start → 就绪行 → 健康探测通过 → running(带 url/port/version)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999991
    child.killCall = []
    child.kill = vi.fn((signal) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never

    const spawnImpl = vi.fn((invocation: SpawnInvocation) => {
      expect(invocation.args).toContain('--no-open')
      expect(invocation.args).toContain('--expose-internals')
      expect(invocation.env['DSH_HOME']).toContain('homes')
      expect(invocation.detached).toBe(true)
      return child as unknown as SpawnedProcess
    })
    const probe = vi.fn(async () => true)
    const installer = makeFakeInstaller()

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe,
      readyTimeoutMs: 2000
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))

    const instance = localInstance()
    // start() 现在会等到「就绪或退出」才返回(TOCTOU 防线):先注入就绪行再 await
    const starting = manager.start(instance)
    child.stdout.write('dsh web: http://127.0.0.1:31234/?token=abc\n')
    await starting
    await waitForStatus(manager, instance.id, 'running')

    const status = manager.statusOf(instance.id)
    expect(status?.url).toBeUndefined()
    expect(status?.port).toBe(31234)
    expect(status?.version).toBe('0.1.5-rc.1')
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:31234/?token=abc', expect.any(Number))
    // #2 后的进度序列:解析来源 → 需下载待确认 → 准备运行时 → 分配端口 → running
    expect(spawnImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        args: expect.arrayContaining(['--profile', 'web', '--no-open'])
      })
    )
    expect(spawnImpl.mock.calls[0]?.[0].args.slice(-5)).toEqual([
      '--profile',
      'web',
      '--port',
      expect.stringMatching(/^\d+$/),
      '--no-open'
    ])
    expect(events.map((event) => event.status)).toEqual([
      'starting',
      'starting',
      'starting',
      'starting',
      'running'
    ])
  })

  it('选择 dush 启动器时由 Hub 固定 web、回环端口和 --no-open', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999990
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      // 固定 node 解析结果,避免测试随开发机是否装有 node 漂移。
      resolveNode: () => null,
      readyTimeoutMs: 2_000
    })

    const instance = localInstance({ launcher: 'dush' })
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting

    expect(spawnImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'dush',
        args: [
          '--profile',
          'web',
          '--port',
          expect.stringMatching(/^\d+$/),
          '--no-open'
        ]
      })
    )
  })

  it('dush 启动不会继承父进程的 DUSH_PATCH_FILE，避免 loader 重复加载', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999988
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const previousPatch = process.env.DUSH_PATCH_FILE
    process.env.DUSH_PATCH_FILE = '/tmp/global/cordis.dush.patch.yml'

    try {
      const manager = createLocalRuntime({
        confirmDownload: async () => true,
        installer: makeFakeInstaller(),
        dataRoot: '/tmp/hub-data',
        spawnImpl: spawnImpl as never,
        resolveNode: () => '/tmp/node',
        pathProbe: {
          probeLauncher: async () => ({ command: '/tmp/dush', version: '0.1.1-rc.3' }),
          probe: async () => null
        },
        readyTimeoutMs: 2_000
      })
      const starting = manager.start(localInstance({ launcher: 'dush' }))
      await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
      child.stdout.write(readyLine())
      await starting

      const invocation = (spawnImpl.mock.calls[0] as unknown as [
        { env: NodeJS.ProcessEnv }
      ])[0]
      expect(invocation.env.DUSH_PATCH_FILE).toBeUndefined()
    } finally {
      if (previousPatch === undefined) delete process.env.DUSH_PATCH_FILE
      else process.env.DUSH_PATCH_FILE = previousPatch
    }
  })

  it('公共空间仅使用主进程提供的 ~/.dsh，不接受渲染层路径', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999989
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      homeDir: () => '/tmp/default-space-home',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 2_000
    })

    const instance = localInstance({ useDefaultSpace: true })
    const starting = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledOnce())
    child.stdout.write(readyLine())
    await starting

    // 实现用 path.join 拼 home,期望值也用 join 构造,避免分隔符随平台漂移
    const defaultSpaceHome = join('/tmp/default-space-home', '.dsh')
    expect(spawnImpl).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: defaultSpaceHome, env: expect.objectContaining({ DSH_HOME: defaultSpaceHome }) })
    )
  })

  it('启动超时未出就绪行 → error + 杀进程', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999992
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      readyTimeoutMs: 80
    })
    const instance = localInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')

    expect(manager.statusOf(instance.id)?.detail).toContain('启动超时')
    expect(child.killCall).toContain('SIGKILL')
    expect(manager.runningIds()).toEqual([])
  })

  it('进程在就绪前意外退出 → error(仅显示退出码)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999993
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 5000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    // 等 spawn 与监听器挂好(同一同步块),再注入退出事件,避免事件丢失
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stderr.write('Error: port already in use\n')
    child.emit('exit', 1, null)
    await starting
    await waitForStatus(manager, instance.id, 'error')

    expect(manager.statusOf(instance.id)?.detail).toContain('code=1')
    // 子进程的 stderr 是启动失败唯一的诊断来源,必须带进详情(该字样不含凭据)。
    expect(manager.statusOf(instance.id)?.detail).toContain('port already in use')
  })

  it('stop:SIGTERM → 子进程退出 → stopped;未退出 → SIGKILL 兜底', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999994
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      // SIGTERM 后不退出 → 需要 SIGKILL 兜底
      if (signal === 'SIGKILL') setImmediate(() => child.emit('exit', 0, 'SIGKILL'))
      return true
    }) as never

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      stopGraceMs: 60
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    await manager.stop(instance.id)
    expect(child.killCall).toEqual(['SIGTERM', 'SIGKILL'])
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
    expect(manager.statusOf(instance.id)?.detail).toContain('强制停止')
    expect(manager.runningIds()).toEqual([])
  })

  it('stop:未运行的 id → 幂等 stopped', async () => {
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data'
    })
    await manager.stop(randomUUID())
    // 事件里会有一条 stopped,但无需运行实体
    expect(manager.runningIds()).toEqual([])
  })

  it('重复 start 幂等:已在运行则不再 spawn', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999995
    child.kill = vi.fn(() => true) as never

    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const installer = makeFakeInstaller()
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    await manager.start(instance)
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(manager.statusOf(instance.id)?.detail).toContain('已在运行')
  })

  it('启动前经 ensureInstalled 准备运行时(指定版本直接用)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999996
    child.kill = vi.fn(() => true) as never

    const installer = makeFakeInstaller()
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await vi.waitFor(() =>
      expect(installer.ensureInstalled).toHaveBeenCalledWith('0.1.5-rc.1', expect.any(Function))
    )

    // 指定版本的实例:直接把该版本交给 ensureInstalled
    const pinned = makeFakeInstaller()
    const manager2 = createLocalRuntime({
      confirmDownload: async () => true,
      installer: pinned,
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      readyTimeoutMs: 2000
    })
    const startingPinned = manager2.start(
      localInstance({ dshVersion: '0.1.4-rc.1', id: randomUUID() })
    )
    child.stdout.write(readyLine())
    await startingPinned
    await vi.waitFor(() =>
      expect(pinned.ensureInstalled).toHaveBeenCalledWith('0.1.4-rc.1', expect.any(Function))
    )
  })

  it('并发启动串行化:A 就绪后才拉起 B(TOCTOU 防线)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999997 - children.length
      child.killCall = []
      child.kill = vi.fn(() => true) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const a = localInstance({ name: 'A' })
    const b = localInstance({ name: 'B' })
    void manager.start(a)
    void manager.start(b)

    // A 先被拉起;未就绪时 B 不允许 spawn(否则两个实例会抢同一端口)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    children[0]?.stdout.write(readyLine())
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2))
    children[1]?.stdout.write(readyLine())

    await waitForStatus(manager, a.id, 'running')
    await waitForStatus(manager, b.id, 'running')
    expect(manager.runningIds().sort()).toEqual([a.id, b.id].sort())
  })

  it('排队期间 stop:取消启动,不再 spawn', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999998
    child.kill = vi.fn(() => true) as never

    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const blocker = makeFakeInstaller({
      ensureInstalled: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60)) // 占住串行队列
        return {
          version: '0.1.5-rc.1',
          dir: '/tmp/runtimes/dsh-0.1.5-rc.1',
          entry: '/tmp/bin.js',
          installedAt: ISO
        }
      })
    })
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: blocker,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 2000
    })
    const a = localInstance({ name: 'A' })
    const b = localInstance({ name: 'B' })
    const startA = manager.start(a)
    const startB = manager.start(b)
    await manager.stop(b.id) // b 尚在排队
    await startA
    await startB

    expect(spawnImpl).toHaveBeenCalledTimes(1) // 只有 a 被拉起
    expect(manager.statusOf(b.id)?.status).toBe('stopped')
  })

  it('抛错路径(安装失败) → error 事件而非未处理拒绝', async () => {
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller({
        resolveDefaultVersion: async () => {
          throw new Error('registry 不可达')
        }
      }),
      dataRoot: '/tmp/hub-data'
    })
    const instance = localInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('registry 不可达')
  })

  it('健康探测连续失败 → error + SIGKILL + 条目清除 + 队列立即放行(不等到期定时器)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999750 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const probe = vi.fn(async (url: string) => !url.includes(':31234'))
    // readyTimeoutMs=60s:若失败路径不 settle,队列会被卡到定时器触发,测试会在此超时
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe,
      readyTimeoutMs: 60_000,
      healthProbeRetries: 5,
      healthProbeRetryMs: 10
    })
    const a = localInstance({ name: 'A' })
    const startA = manager.start(a)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    children[0]?.stdout.write(readyLine(31234)) // A:该端口探测恒失败
    await startA
    await waitForStatus(manager, a.id, 'error')
    expect(children[0]?.killCall).toContain('SIGKILL')
    expect(manager.runningIds()).toEqual([])
    expect(probe).toHaveBeenCalledTimes(5) // 连接期 500ms 重试

    // 队列未被卡死:B 在 60s 定时器未触达的情况下也能立即 spawn
    const b = localInstance({ name: 'B' })
    const startB = manager.start(b)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2))
    children[1]?.stdout.write(readyLine(31235)) // B:健康探测通过
    await startB
    await waitForStatus(manager, b.id, 'running')
  })

  it('健康探测先失败后成功(就绪行先于端口绑定)→ running', async () => {
    let calls = 0
    const probe = vi.fn(async () => {
      calls += 1
      return calls >= 2
    })
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999740
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe,
      readyTimeoutMs: 2000,
      healthProbeRetries: 3,
      healthProbeRetryMs: 10
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')
    expect(probe).toHaveBeenCalledTimes(2)
    expect(child.killCall).toEqual([])
  })

  it('同一 id 并发 start 两次 → 只 spawn 一个进程(队列内二次查重)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999730
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const s1 = manager.start(instance)
    const s2 = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    child.stdout.write(readyLine())
    await Promise.all([s1, s2])
    await waitForStatus(manager, instance.id, 'running')
    expect(spawnImpl).toHaveBeenCalledTimes(1) // 绝不允许双进程共享同一 DSH_HOME
    expect(manager.statusOf(instance.id)?.detail).toContain('已在运行')
  })

  it('stop:先杀运行中的进程,排队中的重复 start 一并取消(不复活)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999720 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        if (signal === 'SIGKILL') setImmediate(() => child.emit('exit', 0, 'SIGKILL'))
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      stopGraceMs: 60
    })
    const instance = localInstance()
    const s1 = manager.start(instance)
    const s2 = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    await manager.stop(instance.id)
    await s1
    await s2
    expect(children[0]?.killCall).toContain('SIGKILL')
    expect(spawnImpl).toHaveBeenCalledTimes(1) // 排队中的 s2 不得把实例重新拉起
    expect(manager.runningIds()).toEqual([])
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
  })

  it('stop 落在 spawn 前最后一个 await 窗口(findFreePort)→ 补杀,不留孤儿进程', async () => {
    let releasePort!: () => void
    const portGate = new Promise<boolean>((resolve) => {
      releasePort = () => resolve(true)
    })
    const portProbe = vi.fn(() => portGate) as never

    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999710
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      portProbe,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    // 队列任务正挂在 findFreePort 上(被 gate 卡住):此刻 stop 只登记取消意图
    await vi.waitFor(() => expect(portProbe).toHaveBeenCalled())
    await manager.stop(instance.id)
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
    releasePort()
    await starting

    // 子进程确实被拉起过,但随即被补杀:不留孤儿、不占端口、不误报 running
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(child.killCall).toContain('SIGKILL')
    expect(manager.runningIds()).toEqual([])
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
  })

  it('陈旧条目的迟到 exit 不误删新条目(身份守卫)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999700 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      stopGraceMs: 40
    })
    const instance = localInstance()

    const first = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    children[0]?.stdout.write(readyLine())
    await first
    await waitForStatus(manager, instance.id, 'running')
    // 停止:SIGTERM/SIGKILL 都不生效(模拟 D 态僵尸)→ stop 自行清理条目
    await manager.stop(instance.id)
    expect(manager.runningIds()).toEqual([])
    // 第二代进程:重新启动并就绪
    const second = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2))
    children[1]?.stdout.write(readyLine())
    await second
    await waitForStatus(manager, instance.id, 'running')
    expect(manager.runningIds()).toEqual([instance.id])

    children[0]?.emit('exit', 0, null)
    expect(manager.runningIds()).toEqual([instance.id])
    expect(manager.statusOf(instance.id)?.status).toBe('running')
  })

  it('就绪行跨 chunk 拆分 → 仍能匹配就绪(running)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999690
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stdout.write('dsh web: http://127.0.0.1:31') // 半行(无换行)
    child.stdout.write('234/?token=abc\n') // 另一半 + 换行
    await starting
    await waitForStatus(manager, instance.id, 'running')
    expect(manager.statusOf(instance.id)?.url).toBeUndefined()
  })

  it('实例自定义端口:优先从该端口起分配(空闲直接用,被占则递增)', async () => {
    // 场景一:30123 空闲 → 直接用用户选定端口
    const portProbe = vi.fn(async (port: number) => port === 30123)
    let args1: string[] = []
    const child1 = new EventEmitter() as unknown as FakeChild
    child1.stdout = new PassThrough()
    child1.stderr = new PassThrough()
    child1.pid = 999680
    child1.killCall = []
    child1.kill = vi.fn(() => true) as never
    const spawnImpl1 = vi.fn((invocation: SpawnInvocation) => {
      args1 = invocation.args
      return child1 as unknown as SpawnedProcess
    })
    const manager1 = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl1 as never,
      portProbe: portProbe as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const inst1 = localInstance({ port: 30123 })
    const starting1 = manager1.start(inst1)
    child1.stdout.write(readyLine(30123))
    await starting1
    await waitForStatus(manager1, inst1.id, 'running')
    expect(portProbe).toHaveBeenCalledWith(30123)
    expect(args1).toEqual(expect.arrayContaining(['--port', '30123']))

    // 场景二:30123 被占 → 递增到 30124
    const portProbe2 = vi.fn(async (port: number) => port === 30124)
    let args2: string[] = []
    const child2 = new EventEmitter() as unknown as FakeChild
    child2.stdout = new PassThrough()
    child2.stderr = new PassThrough()
    child2.pid = 999670
    child2.killCall = []
    child2.kill = vi.fn(() => true) as never
    const spawnImpl2 = vi.fn((invocation: SpawnInvocation) => {
      args2 = invocation.args
      return child2 as unknown as SpawnedProcess
    })
    const manager2 = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl2 as never,
      portProbe: portProbe2 as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const inst2 = localInstance({ id: randomUUID(), port: 30123 })
    const starting2 = manager2.start(inst2)
    child2.stdout.write(readyLine(30124))
    await starting2
    await waitForStatus(manager2, inst2.id, 'running')
    expect(portProbe2).toHaveBeenCalledWith(30123)
    expect(portProbe2).toHaveBeenCalledWith(30124)
    expect(args2).toEqual(expect.arrayContaining(['--port', '30124']))

    // 场景三:用户端口超出默认区间(如 dsh 默认 52300)→ 仍先尝试该端口,被占则向 65535 递增
    const portProbe3 = vi.fn(async (port: number) => port >= 52301)
    let args3: string[] = []
    const child3 = new EventEmitter() as unknown as FakeChild
    child3.stdout = new PassThrough()
    child3.stderr = new PassThrough()
    child3.pid = 999660
    child3.killCall = []
    child3.kill = vi.fn(() => true) as never
    const spawnImpl3 = vi.fn((invocation: SpawnInvocation) => {
      args3 = invocation.args
      return child3 as unknown as SpawnedProcess
    })
    const manager3 = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl3 as never,
      portProbe: portProbe3 as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const inst3 = localInstance({ id: randomUUID(), port: 52300 })
    const starting3 = manager3.start(inst3)
    child3.stdout.write(readyLine(52301))
    await starting3
    await waitForStatus(manager3, inst3.id, 'running')
    expect(portProbe3).toHaveBeenCalledWith(52300) // 用户端口本身先被尝试
    expect(portProbe3).toHaveBeenCalledWith(52301) // 被占后递增,而非静默丢弃
    expect(args3).toEqual(expect.arrayContaining(['--port', '52301']))
  })

  it('在途 handleReady 的陈旧续体不误删新条目(就绪后崩溃场景)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999650 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    // 旧条目 A 的端口(31234)探测恒失败;B(31235)恒成功
    const probe = vi.fn(async (url: string) => url.includes(':31235'))
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe,
      readyTimeoutMs: 5000,
      healthProbeRetries: 3,
      healthProbeRetryMs: 10
    })
    const instance = localInstance()

    const first = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    children[0]?.stdout.write(readyLine(31234))
    children[0]?.emit('exit', 1, null)
    await first
    await waitForStatus(manager, instance.id, 'error') // 进程意外退出
    // 队列已放行,第二代进程拉起并就绪
    const second = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2))
    children[1]?.stdout.write(readyLine(31235))
    await second
    await waitForStatus(manager, instance.id, 'running')
    // 等陈旧 handleReady(A) 的重试耗尽(3 次 × 10ms),再断言其失败终局不得误删第二代条目。
    // 注:本用例锁定的是「换代场景整体」(身份守卫 + exit 置 stopping 的合效果);
    // 单回退身份检查仍会绿 —— 每条换代路径都隐含旧条目 stopping=true,身份检查属于
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(manager.runningIds()).toEqual([instance.id])
    expect(manager.statusOf(instance.id)?.url).toBeUndefined()
    expect(children[0]?.killCall).toEqual([])
  })

  it('stop:子进程永不退出(僵尸/D 态)→ 放行启动队列,排在后面的实例正常启动', async () => {
    // stop(id1) 必须自行 settle 队列,id2 才能开始;readyTimeoutMs 放大到 60s,
    // 防止 ready-timer 兜底触发 settle 而掩盖「缺失的 stop-settle」
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999640 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        return true // 永不触发 exit(模拟 SIGKILL 免疫的 D 态)
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 60_000,
      stopGraceMs: 30
    })
    const inst1 = localInstance({ name: 'A' })
    const inst2 = localInstance({ name: 'B' })
    void manager.start(inst1) // id1:挂住队列头(未就绪、永不退出)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    // id1 已 spawn 但未写就绪行也不退出:串行任务卡在队列头,id2 排在后面
    const s2 = manager.start(inst2)
    await manager.stop(inst1.id) // kill 无效、永不 exit → 只能靠 stop() 自己放行

    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2), { timeout: 2000 })
    children[1]?.stdout.write(readyLine())
    const outcome = await Promise.race([
      s2.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000))
    ])
    expect(outcome).toBe('settled')
    await waitForStatus(manager, inst2.id, 'running')
    expect(manager.runningIds()).toEqual([inst2.id])
    expect(manager.statusOf(inst1.id)?.status).toBe('stopped')
  })
})

describe('#2 运行时来源与下载确认', () => {
  function pathChild(): { child: FakeChild; spawnImpl: ReturnType<typeof vi.fn> } {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 888001
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    return { child, spawnImpl }
  }

  const PATH_DSH = { command: '/usr/local/bin/dsh', version: '0.9.9' }

  it('接管外部 dsh 的状态事件不包含访问 URL', async () => {
    const manager = createLocalRuntime({ installer: makeFakeInstaller(), dataRoot: '/tmp/hub-data' })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))
    await manager.adopt(localInstance(), { pid: 77, port: 3080, patch: null })
    expect(events.at(-1)).toMatchObject({ status: 'running', runtimeSource: 'external', port: 3080 })
    expect(events.at(-1)?.url).toBeUndefined()
  })

  it('未固定实例:PATH 有 dsh → 不安装、直接用本机 dsh 启动,事件带 runtimeSource=path', async () => {
    const { child, spawnImpl } = pathChild()
    const installer = makeFakeInstaller()
    const manager = createLocalRuntime({
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      pathProbe: { probe: async () => ({ ...PATH_DSH }) }
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    // 不走安装(未固定 + PATH 优先):ensureInstalled 绝不能被调
    expect(installer.ensureInstalled).not.toHaveBeenCalled()
    // spawn 经 nodeInvocation + PATH 上的 dsh bin(而不是隔离目录入口)
    const invocation = (spawnImpl.mock.calls[0] as unknown as [
      { command: string; args: string[]; env: NodeJS.ProcessEnv }
    ])[0]
    expect(invocation.args).toContain(PATH_DSH.command)
    expect(invocation.args.some((arg) => arg.includes('runtimes/dsh-'))).toBe(false)
    // running 事件带版本与来源
    const running = events.find((event) => event.status === 'running')
    expect(running?.version).toBe('0.9.9')
    expect(running?.runtimeSource).toBe('path')
    expect(manager.statusOf(instance.id)?.version).toBe('0.9.9')
  })

  it('固定版本:hub 已装同版本 → 用 hub 入口(runtimeSource=hub),不走确认', async () => {
    const { child, spawnImpl } = pathChild()
    const installer = makeFakeInstaller({
      listInstalled: async () => [
        {
          version: '0.1.4-rc.1',
          dir: '/tmp/runtimes/dsh-0.1.4-rc.1',
          entry: '/tmp/runtimes/dsh-0.1.4-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js',
          installedAt: ISO
        }
      ]
    })
    const confirm = vi.fn(async () => true)
    const manager = createLocalRuntime({
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      confirmDownload: confirm,
      pathProbe: { probe: async () => ({ ...PATH_DSH }) } // 版本不匹配,不该被固定版采用
    })
    const instance = localInstance({ dshVersion: '0.1.4-rc.1', id: randomUUID() })
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    expect(confirm).not.toHaveBeenCalled() // hub 命中 → 不需下载 → 不需确认
    const invocation = (spawnImpl.mock.calls[0] as unknown as [
      { command: string; args: string[] }
    ])[0]
    expect(invocation.args.some((arg) => arg.includes('dsh-0.1.4-rc.1'))).toBe(true)
    expect(manager.statusOf(instance.id)?.runtimeSource).toBe('hub')
  })

  it('下载未确认 → stopped,不 spawn、不安装', async () => {
    const { spawnImpl } = pathChild()
    const installer = makeFakeInstaller()
    const manager = createLocalRuntime({
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 2000,
      confirmDownload: async () => false
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))
    const instance = localInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'stopped')

    expect(spawnImpl).not.toHaveBeenCalled()
    expect(installer.ensureInstalled).not.toHaveBeenCalled()
    expect(manager.statusOf(instance.id)?.detail).toContain('未获确认')
  })

  it('未配置确认口(缺省)→ 拒绝下载并 stopped(安全缺省,不静默安装)', async () => {
    const { spawnImpl } = pathChild()
    const installer = makeFakeInstaller()
    const manager = createLocalRuntime({
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never
      // 刻意不传 confirmDownload
    })
    const instance = localInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'stopped')
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(installer.ensureInstalled).not.toHaveBeenCalled()
  })

  it('确认后下载并启动(runtimeSource=hub),未固定实例解析 latest 为下载目标', async () => {
    const { child, spawnImpl } = pathChild()
    const installer = makeFakeInstaller()
    const confirm = vi.fn(async () => true)
    const manager = createLocalRuntime({
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      confirmDownload: confirm
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    expect(confirm).toHaveBeenCalledWith('0.1.5-rc.1') // resolveDefaultVersion 的返回值
    expect(installer.ensureInstalled).toHaveBeenCalledWith('0.1.5-rc.1', expect.any(Function))
    expect(manager.statusOf(instance.id)?.runtimeSource).toBe('hub')
  })
})

describe('C1 凭据脱敏', () => {
  it('就绪 URL 中的 token 不出现在 error detail 中（健康探测失败）', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999600
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never

    // 恒失败探测:触发 detail 中包含就绪 URL 的 error 事件
    const probe = vi.fn(async () => false)
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe,
      readyTimeoutMs: 2000,
      healthProbeRetries: 2,
      healthProbeRetryMs: 10
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))

    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write('dsh web: http://127.0.0.1:31234/?token=SECRET_TOKEN_VALUE\n')
    await starting
    await waitForStatus(manager, instance.id, 'error')

    const errorEvent = events.find((e) => e.status === 'error')
    expect(errorEvent).toBeDefined()
    // detail 中的 URL 必须脱敏:查询串(含 token)被剥离
    expect(errorEvent!.detail).not.toContain('SECRET_TOKEN_VALUE')
    expect(errorEvent!.detail).toContain('http://127.0.0.1:31234')
    // 状态事件绝不携带 bearer token；完整 URL 仅保存在主进程 entry，供 openView 使用。
    expect(errorEvent!.url).toBeUndefined()
  })

  it('pushLog 不脱敏:就绪行匹配不受影响（READY_PATTERN 守卫）', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999601
    child.kill = vi.fn(() => true) as never

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    // 就绪行含完整 token:pushLog 不脱敏才能匹配 READY_PATTERN
    child.stdout.write('dsh web: http://127.0.0.1:31234/?token=my-secret-token\n')
    await starting
    await waitForStatus(manager, instance.id, 'running')

    // 状态事件不暴露 token；运行时内部仍持有完整 URL，供主进程打开工作区。
    expect(manager.statusOf(instance.id)?.url).toBeUndefined()
  })

  it('进程意外退出的详情带子进程日志,但就绪 URL 的 token 必须被脱敏', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999602
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      readyTimeoutMs: 5000
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))

    const instance = localInstance()
    const starting = manager.start(instance)
    await vi.waitFor(() => expect(manager.runningIds()).toContain(instance.id))
    // 子进程先输出诊断行，再输出一行**带 token 的就绪 URL**（后者是凭据，绝不能进详情）。
    child.stderr.write('Error: unsupported Electron runtime fingerprint\n')
    child.stdout.write('dsh web: http://127.0.0.1:52300/?token=super-secret-token\n')
    child.emit('exit', 1, null)
    await starting
    await waitForStatus(manager, instance.id, 'error')

    const errorEvent = events.findLast((event) => event.status === 'error')
    expect(errorEvent).toBeDefined()
    // 失败原因可见（这是启动失败时唯一的诊断来源）。
    expect(errorEvent!.detail).toContain('unsupported Electron runtime fingerprint')
    // 但凭据必须已被 redactLine 脱敏。
    expect(errorEvent!.detail).not.toContain('super-secret-token')
    expect(errorEvent!.detail).not.toContain('token=')
  })

  it('path 来源用真实 node 执行本机启器,不用 Electron 充当 Node', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999701
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      pathProbe: {
        probe: async () => ({ command: '/Users/example/.local/bin/dsh', version: '0.1.6-alpha.2' })
      },
      // 本机启动器是 #!/usr/bin/env node 脚本:必须交给真实 node,
      // 用 Electron(ELECTRON_RUN_AS_NODE)会被 dsh 原生插件的运行时指纹拒绝而 code=1。
      resolveNode: (scriptPath) => (scriptPath.endsWith('/dsh') ? '/Users/example/.local/bin/node' : null),
      readyTimeoutMs: 2_000
    })

    const starting = manager.start(localInstance())
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stdout.write(readyLine())
    await starting

    const invocation = (spawnImpl.mock.calls[0] as unknown as [
      { command: string; args: string[]; env: NodeJS.ProcessEnv }
    ])[0]
    expect(invocation.command).toBe('/Users/example/.local/bin/node')
    expect(invocation.args.slice(0, 2)).toEqual([
      '--expose-internals',
      '/Users/example/.local/bin/dsh'
    ])
    // 绝不能给真实 node 带上 Electron 的降级开关。
    expect(invocation.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    // 让 dsh spawn 的子进程也能找到同一个 node。
    expect(invocation.env.PATH?.startsWith('/Users/example/.local/bin')).toBe(true)
  })

  it('找不到 node 时按脚本 shebang 直接执行,不悄悄回退到 Electron', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999702
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      pathProbe: {
        probe: async () => ({ command: '/Users/example/.local/bin/dsh', version: '0.1.6-alpha.2' })
      },
      resolveNode: () => null,
      readyTimeoutMs: 2_000
    })

    const starting = manager.start(localInstance())
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stdout.write(readyLine())
    await starting

    const invocation = (spawnImpl.mock.calls[0] as unknown as [
      { command: string; args: string[] }
    ])[0]
    expect(invocation.command).toBe('/Users/example/.local/bin/dsh')
    expect(invocation.args).not.toContain('--expose-internals')
  })
})

describe('R2 stopping+start 处理', () => {
  it('stopAll 会取消全局队列中尚未建立 entry 的启动任务', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999300 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        setImmediate(() => child.emit('exit', 0, signal ?? 'SIGTERM'))
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2_000,
      stopGraceMs: 20
    })
    const first = localInstance()
    const second = localInstance({ id: randomUUID() })
    const startFirst = manager.start(first)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    const startSecond = manager.start(second)

    await manager.stopAll()
    await Promise.all([startFirst, startSecond])

    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(manager.runningIds()).toEqual([])
    expect(manager.statusOf(second.id)?.status).toBe('stopped')
  })

  it('实例正在停止时收到新 start → 新启动排队执行（不被忽略）', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999500 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        if (signal === 'SIGKILL') setImmediate(() => child.emit('exit', 0, 'SIGKILL'))
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createLocalRuntime({
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      stopGraceMs: 30
    })
    const instance = localInstance()
    const first = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    children[0]?.stdout.write(readyLine())
    await first
    await waitForStatus(manager, instance.id, 'running')

    // 开始停止：entry.stopping = true 但还没删除
    const stopping = manager.stop(instance.id)
    // 在停止过程中立即 start
    const second = manager.start(instance)

    // 等第二个 spawn 发生
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2))
    // 给第二个子进程就绪行
    children[1]?.stdout.write(readyLine())

    // 两者都应正常完成
    await stopping
    await second
    await waitForStatus(manager, instance.id, 'running')

    // 第二代进程被拉起
    expect(manager.runningIds()).toEqual([instance.id])
  })
})
