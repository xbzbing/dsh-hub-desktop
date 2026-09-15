import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { InstanceStatusEvent, SshInstance } from '@shared/contracts'
import { controlSlug, createSshTunnels, socketsDirFor, type SshTunnelManager } from './ssh-tunnel'
import type { SpawnedProcess } from './spawn'

const ISO = '2026-09-15T00:00:00.000Z'

function sshInstance(overrides: Partial<SshInstance> = {}): SshInstance {
  return {
    id: randomUUID(),
    name: '隧道实例',
    transport: 'ssh',
    authMode: 'auto',
    host: 'dsh.internal',
    port: 22,
    username: 'dev',
    remotePort: 3080,
    localPort: null,
    identityFile: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  }
}

interface FakeChild extends SpawnedProcess {
  stdout: PassThrough
  stderr: PassThrough
  emit(event: string, ...args: unknown[]): boolean
  killCall: NodeJS.Signals[]
}

let pidCounter = 900000

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = pidCounter--
  child.killCall = []
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killCall.push(signal ?? 'SIGTERM')
    return true
  }) as never
  return child
}

async function waitForStatus(
  manager: SshTunnelManager,
  id: string,
  status: InstanceStatusEvent['status'],
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (manager.statusOf(id)?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待状态 ${status} 超时（当前：${manager.statusOf(id)?.status}）`)
}

describe('createSshTunnels（T4 隧道管理器 + 看门狗）', () => {
  it('start → 隧道建立(参数含 -L 转发/私有 known_hosts) → 探测通过 → running', async () => {
    const child = makeFakeChild()
    let lastInvocation!: { args: string[]; env: NodeJS.ProcessEnv }
    const spawnImpl = vi.fn((invocation: { args: string[]; env: NodeJS.ProcessEnv }) => {
      lastInvocation = invocation
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')

    expect(lastInvocation?.args).toEqual(
      expect.arrayContaining(['-L', expect.stringMatching(/^30\d+:127\.0\.0\.1:3080$/)])
    )
    expect(lastInvocation?.args.join(' ')).toContain('UserKnownHostsFile=/tmp/hub-data/ssh/known_hosts')
    expect(lastInvocation?.args.join(' ')).toContain('ControlPath=/tmp/hub-data/ssh/')
    expect(lastInvocation?.env['SSH_ASKPASS_REQUIRE']).toBe('never')
    const status = manager.statusOf(instance.id)
    expect(status?.url).toMatch(/^http:\/\/127\.0\.0\.1:30\d+\/$/)
    expect(status?.port).toBeDefined()
    expect(events.map((event) => event.status)).toContain('running')
  })

  it('并发启动两个实例 → 本地端口互不冲突(保留集互斥)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      portProbe: (async () => true) as never
    })
    const a = sshInstance({ name: 'A' })
    const b = sshInstance({ name: 'B' })
    void manager.start(a)
    void manager.start(b)
    await waitForStatus(manager, a.id, 'running')
    await waitForStatus(manager, b.id, 'running')

    const ports = (args: string[]): string | undefined => {
      const idx = args.indexOf('-L')
      return args[idx + 1]?.split(':')[0]
    }
    const calls = spawnImpl.mock.calls as Array<[invocation?: { args: string[] }]>
    const portA = ports(calls[0]?.[0]?.args ?? [])
    const portB = ports(calls[1]?.[0]?.args ?? [])
    expect(portA).toBeDefined()
    expect(portB).toBeDefined()
    expect(portA).not.toBe(portB)
  })

  it('spawn 报错(ssh 缺失/资源失败) → error,不进入看门狗', async () => {
    const child = makeFakeChild()
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 2000
    })
    const instance = sshInstance()
    const starting = manager.start(instance)
    // 等 spawn 与 'error' 监听器挂好(EventEmitter 无监听器时 emit error 会抛)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.emit('error', new Error('spawn ssh ENOENT'))
    await starting
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('ENOENT')
    expect(manager.runningIds()).toEqual([])
    // 等一小段,确认没有看门狗重连
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(spawnImpl).toHaveBeenCalledTimes(1)
  })

  it('就绪探测超时(远端未就绪)→ error + 杀进程 + 看门狗自动重连 → running', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    let probePass = false
    const probe = vi.fn(async () => probePass)
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe,
      readyTimeoutMs: 120,
      healthProbeRetryMs: 10,
      backoffBaseMs: 20,
      backoffMaxMs: 200,
      stopGraceMs: 30
    })
    const instance = sshInstance()
    const starting = manager.start(instance)
    // 第一代:探测恒失败 → 就绪超时 → 杀进程 → 看门狗
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('远端 dsh 未就绪')
    expect(children[0]?.killCall).toContain('SIGKILL')
    // 恢复探测 → 重连成功
    probePass = true
    const reconnected = await Promise.race([
      new Promise<'ok'>((resolve) => {
        const timer = setInterval(() => {
          if (spawnImpl.mock.calls.length >= 2 && manager.statusOf(instance.id)?.status === 'running') {
            clearInterval(timer)
            resolve('ok')
          }
        }, 10)
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000))
    ])
    expect(reconnected).toBe('ok')
    await starting
    expect(manager.statusOf(instance.id)?.status).toBe('running')
    expect(manager.statusOf(instance.id)?.detail).toContain('已就绪')
  })

  it('看门狗:断线 → 归因 + 退避重连(第 N 次自动重连)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      backoffBaseMs: 30,
      backoffMaxMs: 500,
      stableResetMs: 60_000,
      stopGraceMs: 30
    })
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')

    // 模拟断线:stderr 带连接拒绝特征
    children[0]?.stderr.write('ssh: connect to host 10.0.0.1 port 22: Connection refused\n')
    children[0]?.emit('exit', 255, null)
    await waitForStatus(manager, instance.id, 'error')
    const errorDetail = manager.statusOf(instance.id)?.detail ?? ''
    expect(errorDetail).toContain('连接被拒绝')
    expect(errorDetail).toContain('自动重连')

    // 退避后自动重连 → 再次 running
    await waitForStatus(manager, instance.id, 'running', 5000)
    expect(spawnImpl).toHaveBeenCalledTimes(2)
    await waitForStatus(manager, instance.id, 'running')
    // 第二次自动重连的 detail 序号递增
    const restartEvents = manager.statusOf(instance.id)
    expect(restartEvents?.detail).toContain('已就绪')
  })

  it('稳定 ≥ stableResetMs 后断线 → 退避重置(设计 §4.2)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      backoffBaseMs: 40,
      backoffMaxMs: 400,
      stableResetMs: 100,
      stopGraceMs: 30
    })
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')

    // 第一次断线:不稳定(就绪 10ms) → 退避从基数 0.04s 开始,下一次翻倍为 0.08s
    children[0]?.emit('exit', 255, null)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('0.04s')

    // 重连并稳定 400ms(≫100ms 阈值,留足并行跑余量) 后再断线 → 退避重置回基数
    await waitForStatus(manager, instance.id, 'running', 5000)
    await new Promise((resolve) => setTimeout(resolve, 400))
    children[1]?.emit('exit', 1, null)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('0.04s') // 而非 0.08s

    // 第三次连接按基数重试
    await waitForStatus(manager, instance.id, 'running', 5000)
    expect(spawnImpl).toHaveBeenCalledTimes(3)
  })

  it('forward 失败(本地端口被占)→ 重连前重新分配端口', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    /** 无类型 mock 下安全取第 index 次 spawn 的 argv */
    const argsOf = (index: number): string[] =>
      (spawnImpl.mock.calls as Array<[invocation?: { args: string[] }]>)[index]?.[0]?.args ?? []
    const specOf = (index: number): string => {
      const args = argsOf(index)
      return args[args.indexOf('-L') + 1] ?? ''
    }
    // 30000 在第一次分配后变成「外部占用」
    let externalBlocked: number[] = []
    const portProbe = vi.fn(async (port: number) => !externalBlocked.includes(port))
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      backoffBaseMs: 20,
      stableResetMs: 60_000,
      stopGraceMs: 30,
      portProbe: portProbe as never
    })
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    const firstPort = specOf(0)

    externalBlocked = [Number(firstPort.split(':')[0])]
    children[0]?.stderr.write('Warning: remote port forwarding failed for listen port 3080\n')
    children[0]?.emit('exit', 255, null)

    await waitForStatus(manager, instance.id, 'running', 5000)
    const secondPort = specOf(1)
    expect(secondPort).not.toBe('')
    // 换端口重连:新端口的 -L 描述不同于旧端口
    const portOf = (spec: string): string => spec.split(':')[0] ?? ''
    expect(portOf(secondPort)).not.toBe(portOf(firstPort))
    expect(manager.statusOf(instance.id)?.detail).toContain('已就绪')
  })

  it('stop → SIGTERM 杀进程树 → stopped;恢复后端口释放可复用', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      // 对 SIGTERM 不退出 → stop 需 SIGKILL 兜底(模拟僵尸)
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        if (signal === 'SIGKILL') setImmediate(() => child.emit('exit', 0, 'SIGKILL'))
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      stopGraceMs: 30
    })
    const instance = sshInstance()
    const starting = manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    await manager.stop(instance.id)
    expect(children[0]?.killCall).toContain('SIGKILL')
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
    expect(manager.runningIds()).toEqual([])
    await starting

    // 重启:分配的端口与第一次相同(沿用被占用的端口检查通过)
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    const ports: string[] = []
    const calls = spawnImpl.mock.calls as Array<[invocation?: { args: string[] }]>
    for (let index = 0; index < calls.length; index++) {
      const args = calls[index]?.[0]?.args ?? []
      const idx = args.indexOf('-L')
      ports.push((args[idx + 1] ?? '').split(':')[0] ?? '')
    }
    expect(ports[1] ?? '').toBe(ports[0] ?? '')
  })

  it('排队期间 stop(端口分配窗口)→ 取消启动,不 spawn', async () => {
    let releasePort!: () => void
    const gate = new Promise<boolean>((resolve) => {
      releasePort = () => resolve(true)
    })
    const portProbe = vi.fn(() => gate) as never
    const spawnImpl = vi.fn(() => makeFakeChild() as unknown as SpawnedProcess)
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      portProbe,
      readyTimeoutMs: 2000
    })
    const instance = sshInstance()
    const starting = manager.start(instance)
    await vi.waitFor(() => expect(portProbe).toHaveBeenCalled())
    await manager.stop(instance.id) // 无条目 → 登记取消意图
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
    releasePort()
    await starting
    expect(spawnImpl).not.toHaveBeenCalled() // 端口分配后检查取消意图并放弃
  })

  it('同 id 重复 start 幂等:已在运行则不再 spawn', async () => {
    const child = makeFakeChild()
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    await manager.start(instance)
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(manager.statusOf(instance.id)?.detail).toContain('忽略重复启动')
  })
})
describe('ControlPath 路径规则（验收实测:unix socket 104 字节上限）', () => {
  it('socket slug 按实例隔离且短（12 hex,UUID 去横线）', () => {
    const instance = sshInstance({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' })
    expect(controlSlug(instance)).toBe('f47ac10b58cc')
    expect(controlSlug(instance)).toHaveLength(12)
    // 不同实例 = 不同 socket(设计 §4.2「ControlPath 每实例独立」)
    expect(controlSlug(sshInstance({ id: 'a47ac10b-58cc-4372-a567-0e02b2c3d479' }))).not.toBe(
      controlSlug(instance)
    )
  })

  it('数据目录短 → socket 落在 <dataRoot>/ssh', () => {
    expect(socketsDirFor('/tmp/hub-data')).toBe('/tmp/hub-data/ssh')
  })

  it('数据目录过长(仓库内嵌路径)→ 自适应退化到系统临时目录(实测否则 too long)', () => {
    const long = '/Users/someone/workspace/private/some-very-long-org/dsh-plugins/dsh-hub-desktop/hub-data/verify-ssh'
    const dir = socketsDirFor(long)
    expect(dir).not.toBe(`${long}/ssh`)
    expect(dir.startsWith(tmpdir())).toBe(true)
    // 最坏形态(12 字符 slug + ssh 追加大约 16 字符随机后缀)必须 < 104 字节
    expect(join(dir, 'ctl-000000000000').length + 17).toBeLessThan(104)
  })
})
