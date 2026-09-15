import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { HttpInstance, InstanceStatusEvent } from '@shared/contracts'
import { createHttpEndpoints } from './http-endpoint'

const ISO = '2026-09-15T00:00:00.000Z'

function httpInstance(overrides: Partial<HttpInstance> = {}): HttpInstance {
  return {
    id: randomUUID(),
    name: '远程直连',
    transport: 'http',
    authMode: 'auto',
    endpointUrl: 'https://gw.example.com/dsh',
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  }
}

async function waitForStatus(
  manager: ReturnType<typeof createHttpEndpoints>,
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

describe('createHttpEndpoints（T6 HTTP 直连传输）', () => {
  it('start → 健康探测通过 + 自动探测 gateway → running（detail 带探测结论）', async () => {
    const probe = vi.fn(async () => true)
    const detect = vi.fn(async () => ({
      mode: 'gateway' as const,
      gatewayEvidence: 'login-page' as const,
      evidence: '302 → /login（网关登录页重定向）',
      status: 302,
      at: ISO
    }))
    const manager = createHttpEndpoints({ probe, detect })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))
    const instance = httpInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    expect(probe).toHaveBeenCalledWith('https://gw.example.com/dsh/', expect.any(Number))
    expect(detect).toHaveBeenCalledWith('https://gw.example.com/dsh/')
    expect(manager.statusOf(instance.id)?.detail).toContain('检测到登录认证')
    expect(manager.statusOf(instance.id)?.url).toBe('https://gw.example.com/dsh/')
    expect(events.some((event) => event.detail === '探测认证模式')).toBe(true)
  })

  it('authMode=none 显式指定 → 跳过探测', async () => {
    const detect = vi.fn()
    const manager = createHttpEndpoints({ probe: async () => true, detect })
    const instance = httpInstance({ authMode: 'none' })
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    expect(detect).not.toHaveBeenCalled()
    expect(manager.statusOf(instance.id)?.detail).toContain('跳过登录认证')
  })

  it('端点不可达（探测失败）→ error，且不进入 running', async () => {
    const manager = createHttpEndpoints({
      probe: async () => false,
      healthProbeRetries: 2,
      healthProbeRetryMs: 5
    })
    const instance = httpInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('端点不可达')
    expect(manager.runningIds()).toEqual([])
  })

  it('非法端点 URL → error（由 shared/endpoint 校验抛出）', async () => {
    const manager = createHttpEndpoints({ probe: async () => true })
    const instance = httpInstance({ endpointUrl: 'ftp://x' })
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.runningIds()).toEqual([])
  })

  it('stop → stopped；重复 start 幂等', async () => {
    const manager = createHttpEndpoints({ probe: async () => true, detect: async () => ({
      mode: 'none' as const,
      gatewayEvidence: null,
      evidence: '200 可直接访问',
      status: 200,
      at: ISO
    }) })
    const instance = httpInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    await manager.start(instance)
    expect(manager.statusOf(instance.id)?.detail).toContain('忽略重复启动')
    await manager.stop(instance.id)
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
    expect(manager.runningIds()).toEqual([])
  })

  it('probe 抛异常 → error 而非未处理拒绝', async () => {
    const manager = createHttpEndpoints({
      probe: async () => {
        throw new Error('dns 失败')
      }
    })
    const instance = httpInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('dns 失败')
  })
})
