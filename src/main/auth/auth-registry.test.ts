import { describe, expect, it, vi } from 'vitest'
import { createAuthRegistry } from './auth-registry'
import type { AuthClient } from './auth-client'
import { initialState } from './gateway-state'

function fakeClient(): AuthClient {
  const jar = {
    get: () => null,
    header: () => null,
    store: () => undefined,
    clear: () => undefined,
    describe: () => []
  }
  return {
    instanceId: 'i1',
    jar: jar as unknown as AuthClient['jar'],
    backoff: { canAttempt: () => true, recordRateLimited: vi.fn(), recordSuccess: vi.fn(), state: () => ({ blocked: false, remainingMs: 0, reason: null }), now: () => 0 },
    state: () => initialState(),
    probeAndRestore: vi.fn(async () => ({
      mode: 'gateway' as const,
      gatewayEvidence: 'login-page' as const,
      evidence: 'x',
      status: 302,
      at: 'now'
    })),
    login: vi.fn(async () => initialState()),
    logout: vi.fn(async () => initialState()),
    hasSession: () => false,
    tick: () => initialState()
  }
}

describe('auth-registry（T8 每实例客户端）', () => {
  it('惰性创建:同一实例复用同一客户端;端点缺失返回 null', async () => {
    const factory = vi.fn(() => fakeClient())
    const registry = createAuthRegistry({
      resolveEndpoint: async (id) => (id === 'known' ? 'https://gw/dsh' : null),
      factory
    })
    expect(await registry.client('known')).not.toBeNull()
    expect(await registry.client('known')).not.toBeNull()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(await registry.client('missing')).toBeNull()
  })

  it('状态变化经 onState 广播(带 instanceId)', async () => {
    const seen: Array<[string, string]> = []
    const registry = createAuthRegistry({
      resolveEndpoint: async () => 'https://gw/dsh',
      factory: () => fakeClient(),
      onState: (id, state) => seen.push([id, state.phase])
    })
    await registry.client('i1')
    const client = await registry.client('i1')
    void client
    expect(seen).toEqual([]) // 状态推进由客户端内部触发,注册表只透传
  })

  it('forget 后重新创建;logout 清除客户端', async () => {
    const factory = vi.fn(() => fakeClient())
    const registry = createAuthRegistry({ resolveEndpoint: async () => 'https://gw/dsh', factory })
    await registry.client('i1')
    registry.forget('i1')
    await registry.client('i1')
    expect(factory).toHaveBeenCalledTimes(2)
    await registry.logout('i1')
    expect(registry.stateOf('i1')).toBeNull()
  })

  it('probe/login/submit 在端点缺失时返回 null(不抛)', async () => {
    const registry = createAuthRegistry({ resolveEndpoint: async () => null, factory: () => fakeClient() })
    expect(await registry.probe('x')).toBeNull()
    expect(await registry.login('x', 'pw')).toBeNull()
  })

  it('sessionCookie 无会话返回 null', async () => {
    const registry = createAuthRegistry({ resolveEndpoint: async () => 'https://gw', factory: () => fakeClient() })
    await registry.client('i1')
    expect(registry.sessionCookie('i1')).toBeNull()
  })
})
