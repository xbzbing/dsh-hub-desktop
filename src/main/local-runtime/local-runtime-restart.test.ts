import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceStatusEvent, LocalInstance } from '@shared/contracts'
import { createLocalRuntime } from './local-runtime'
import type { LocalRuntimeManager } from './local-runtime'
import type { RestartPolicy } from './local-restart-policy'
import type { SpawnedProcess } from '../transport/spawn'
import {
  localInstance,
  makeFakeChild,
  makeFakeInstaller,
  readyLine,
  waitForStatus,
  type FakeChild
} from './local-runtime.testkit'

/**
 * 自动重启的接线：开启后意外退出 → 退避 → 重新拉起；关闭/停止/退出应用时不得偷偷拉起。
 * 退避数值本身由 local-restart-policy.test.ts 穷举，这里只验证调度与取消语义。
 */
const MAX_START_FAILURES = 3
const POLICY: Partial<RestartPolicy> = {
  baseMs: 20,
  maxMs: 80,
  stableMs: 1_000,
  maxStartFailures: MAX_START_FAILURES
}

let dataRoot: string
const managers: LocalRuntimeManager[] = []

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'dsh-hub-restart-'))
})

afterEach(async () => {
  // 先停掉所有定时器与假进程，避免定时器在用例之间串扰。
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll().catch(() => undefined)))
  await rm(dataRoot, { recursive: true, force: true })
})

/** 停止时立即回报 exit 的假子进程：让 stop() 不必等真实超时。 */
function makeRestartChild(pid: number): FakeChild {
  const child = makeFakeChild({ pid })
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    child.killCall.push(signal ?? 'SIGTERM')
    setImmediate(() => child.emit('exit', 0, signal ?? 'SIGTERM'))
    return true
  }) as never
  return child
}

interface Harness {
  manager: LocalRuntimeManager
  store: {
    update: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
  }
  children: FakeChild[]
  spawnImpl: ReturnType<typeof vi.fn>
  events: InstanceStatusEvent[]
}

function createHarness(
  record: LocalInstance,
  options: { spawnOverride?: (children: FakeChild[]) => SpawnedProcess } = {}
): Harness {
  const children: FakeChild[] = []
  const spawnImpl = vi.fn(() => {
    const child = options.spawnOverride
      ? options.spawnOverride(children)
      : makeRestartChild(999_800 - children.length)
    children.push(child as FakeChild)
    return child
  })
  const store = {
    update: vi.fn(async () => record),
    get: vi.fn(async () => record)
  }
  const events: InstanceStatusEvent[] = []
  const manager = createLocalRuntime({
    store,
    installer: makeFakeInstaller(),
    dataRoot,
    pathProbe: { probe: async () => ({ command: '/fake/dsh', version: '9.9.9' }) },
    spawnImpl: spawnImpl as never,
    probe: async () => true,
    portProbe: async () => true,
    resolveNode: () => '/usr/bin/node',
    loginPath: async () => null,
    shellEnv: async () => null,
    readyTimeoutMs: 2_000,
    stopGraceMs: 30,
    restartPolicy: POLICY
  })
  manager.onStatus((event) => events.push(event))
  managers.push(manager)
  return { manager, store, children, spawnImpl, events }
}

async function boot(harness: Harness, record: LocalInstance): Promise<void> {
  const started = harness.manager.start(record)
  await vi.waitFor(() => expect(harness.spawnImpl).toHaveBeenCalledTimes(1))
  harness.children[0]?.stdout.write(readyLine())
  await started
  await waitForStatus(harness.manager, record.id, 'running')
}

describe('本机实例意外退出自动重启', () => {
  it('开启后：意外退出发布失败状态，退避后重新拉起并再次就绪', async () => {
    const record = localInstance({ autoRestart: true })
    const harness = createHarness(record)
    await boot(harness, record)

    harness.children[0]?.emit('exit', 0, null)

    await waitForStatus(harness.manager, record.id, 'error')
    expect(harness.manager.statusOf(record.id)?.detail).toContain('自动重启')
    await vi.waitFor(() => expect(harness.spawnImpl).toHaveBeenCalledTimes(2), { timeout: 1_000 })
    harness.children[1]?.stdout.write(readyLine(31235))
    await waitForStatus(harness.manager, record.id, 'running')
  })

  it('未开启：保持原有的失败终态，不再拉起', async () => {
    const record = localInstance({ autoRestart: false })
    const harness = createHarness(record)
    await boot(harness, record)

    harness.children[0]?.emit('exit', 1, null)

    await waitForStatus(harness.manager, record.id, 'error')
    expect(harness.manager.statusOf(record.id)?.detail).not.toContain('自动重启')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1)
  })

  it('运行中关掉开关：本次退出按关闭处理，不再重启', async () => {
    const record = localInstance({ autoRestart: true })
    const harness = createHarness(record)
    await boot(harness, record)
    record.autoRestart = false

    harness.children[0]?.emit('exit', 0, null)

    await waitForStatus(harness.manager, record.id, 'error')
    expect(harness.manager.statusOf(record.id)?.detail).not.toContain('自动重启')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1)
  })

  it('退避等待中手动停止：取消待执行的重启', async () => {
    const record = localInstance({ autoRestart: true })
    const harness = createHarness(record)
    await boot(harness, record)

    harness.children[0]?.emit('exit', 0, null)
    await waitForStatus(harness.manager, record.id, 'error')

    await harness.manager.stop(record.id)
    expect(harness.manager.statusOf(record.id)).toMatchObject({
      status: 'stopped',
      detail: '已取消待执行的自动重启'
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1)
  })

  it('退出决策读取注册表期间手动停止：迟到的重启安排作废', async () => {
    const record = localInstance({ autoRestart: true })
    const harness = createHarness(record)
    await boot(harness, record)

    // 让退出处理器停在读取注册表这一步，再模拟用户停止，最后放行读取。
    const gate: { release: () => void } = { release: () => undefined }
    const readGate = new Promise<void>((resolve) => {
      gate.release = resolve
    })
    harness.store.get.mockImplementationOnce(async () => {
      await readGate
      return record
    })

    harness.children[0]?.emit('exit', 0, null)
    await harness.manager.stop(record.id)
    gate.release()

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.manager.statusOf(record.id)?.status).toBe('stopped')
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1)
  })

  it('运行中手动停止：进程退出后不触发自动重启', async () => {
    const record = localInstance({ autoRestart: true })
    const harness = createHarness(record)
    await boot(harness, record)

    await harness.manager.stop(record.id)

    expect(harness.manager.statusOf(record.id)?.status).toBe('stopped')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1)
  })

  it('stopAll（应用退出）：取消待执行的重启', async () => {
    const record = localInstance({ autoRestart: true })
    const harness = createHarness(record)
    await boot(harness, record)

    harness.children[0]?.emit('exit', 0, null)
    await waitForStatus(harness.manager, record.id, 'error')

    await harness.manager.stopAll()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.spawnImpl).toHaveBeenCalledTimes(1)
  })

  it('退避等待中手动启动：立即拉起且不再执行排队的重启', async () => {
    const record = localInstance({ autoRestart: true })
    const harness = createHarness(record)
    await boot(harness, record)

    harness.children[0]?.emit('exit', 0, null)
    await waitForStatus(harness.manager, record.id, 'error')

    const restarted = harness.manager.start(record)
    await vi.waitFor(() => expect(harness.spawnImpl).toHaveBeenCalledTimes(2))
    harness.children[1]?.stdout.write(readyLine(31236))
    await restarted
    await waitForStatus(harness.manager, record.id, 'running')

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.spawnImpl).toHaveBeenCalledTimes(2)
  })

  it('连续未能就绪达到上限：放弃自动重启并给出可行动原因', async () => {
    const record = localInstance({ autoRestart: true })
    // 每个假进程拉起后立刻以非零码退出，模拟坏配置下起不来。
    const harness = createHarness(record, {
      spawnOverride: () => {
        const child = makeRestartChild(999_700)
        setImmediate(() => child.emit('exit', 1, null))
        return child as unknown as SpawnedProcess
      }
    })

    void harness.manager.start(record)

    await vi.waitFor(
      () => {
        expect(harness.manager.statusOf(record.id)?.detail).toContain('停止自动重启')
      },
      { timeout: 2_000 }
    )
    expect(harness.spawnImpl).toHaveBeenCalledTimes(MAX_START_FAILURES)
  })
})
