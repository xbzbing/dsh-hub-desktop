import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
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
} {
  const base: RuntimeInstaller = {
    listAvailableVersions: async () => ['0.1.5-rc.1'],
    resolveDefaultVersion: async () => '0.1.5-rc.1',
    listInstalled: async () => [],
    isInstalled: async (version) => version === '0.1.5-rc.1',
    install: vi.fn(async () => ({
      version: '0.1.5-rc.1',
      dir: '/tmp/runtimes/dsh-0.1.5-rc.1',
      entry: '/tmp/runtimes/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js',
      installedAt: ISO
    })),
    resolveEntry: (version) => `/tmp/runtimes/dsh-${version}/lib/bin.js`,
    hasIncompleteInstall: async () => false,
    ...overrides
  }
  return base as RuntimeInstaller & { install: ReturnType<typeof vi.fn> }
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
      expect(invocation.env['DSH_HOME']).toContain('homes')
      expect(invocation.detached).toBe(true)
      return child as unknown as SpawnedProcess
    })
    const probe = vi.fn(async () => true)
    const installer = makeFakeInstaller()

    const manager = createLocalRuntime({
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe,
      readyTimeoutMs: 2000
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))

    const instance = localInstance()
    await manager.start(instance)
    child.stdout.write('dsh web: http://127.0.0.1:31234/?token=abc\n')
    await waitForStatus(manager, instance.id, 'running')

    const status = manager.statusOf(instance.id)
    expect(status?.url).toBe('http://127.0.0.1:31234/?token=abc')
    expect(status?.port).toBe(31234)
    expect(status?.version).toBe('0.1.5-rc.1')
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:31234/?token=abc', expect.any(Number))
    expect(events.map((event) => event.status)).toEqual(['starting', 'starting', 'running'])
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

  it('进程在就绪前意外退出 → error(带退出码与日志)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999993
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never

    const manager = createLocalRuntime({
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      readyTimeoutMs: 5000
    })
    const instance = localInstance()
    await manager.start(instance)
    child.stderr.write('Error: port already in use\n')
    child.emit('exit', 1, null)
    await waitForStatus(manager, instance.id, 'error')

    expect(manager.statusOf(instance.id)?.detail).toContain('code=1')
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
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      stopGraceMs: 60
    })
    const instance = localInstance()
    await manager.start(instance)
    child.stdout.write(readyLine())
    await waitForStatus(manager, instance.id, 'running')

    await manager.stop(instance.id)
    expect(child.killCall).toEqual(['SIGTERM', 'SIGKILL'])
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
    expect(manager.statusOf(instance.id)?.detail).toContain('强制停止')
    expect(manager.runningIds()).toEqual([])
  })

  it('stop:未运行的 id → 幂等 stopped', async () => {
    const manager = createLocalRuntime({
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
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    await manager.start(instance)
    child.stdout.write(readyLine())
    await waitForStatus(manager, instance.id, 'running')

    await manager.start(instance)
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(manager.statusOf(instance.id)?.detail).toContain('已在运行')
  })

  it('未安装版本时先 install 再 spawn;已指定版本则直接用', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999996
    child.kill = vi.fn(() => true) as never

    const installer = makeFakeInstaller({
      isInstalled: async () => false
    })
    const manager = createLocalRuntime({
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    await manager.start(instance)
    expect(installer.install).toHaveBeenCalledWith('0.1.5-rc.1')

    // 指定版本的实例:不查 latest,直接校验
    const pinned = makeFakeInstaller()
    const manager2 = createLocalRuntime({
      installer: pinned,
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      readyTimeoutMs: 2000
    })
    await manager2.start(localInstance({ dshVersion: '0.1.4-rc.1', id: randomUUID() }))
    // isInstalled(0.1.4-rc.1) 在假安装器里返回 false → 触发 install(0.1.4-rc.1)
    expect(pinned.install).toHaveBeenCalledWith('0.1.4-rc.1')
  })

  it('抛错路径(安装失败) → error 事件而非未处理拒绝', async () => {
    const manager = createLocalRuntime({
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
})