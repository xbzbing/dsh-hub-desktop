/**
 * 契约测试(对真实网关):验证 hub 的 GatewayClient 与 dsh-auth-gateway 的协议一致。
 * 真值来源:本机网关源码 v0.7.2(lib/gateway.js / lib/auth.js)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGatewayClient } from '../../src/main/auth/gateway-client'
import { startGatewayFixture } from '../../scripts/gateway-fixture.mjs'

interface Fixture {
  baseUrl: string
  password: string
  stop(): Promise<void>
}

let fixture: Fixture

beforeAll(async () => {
  fixture = (await startGatewayFixture({ password: 'contract-pass-123!' })) as Fixture
}, 30_000)

afterAll(async () => {
  await fixture?.stop()
})

describe('契约:对真实 dsh-auth-gateway', () => {
  it('正确密码 → 200 {ok:true} + Set-Cookie dsh_auth,会话可静默恢复', async () => {
    const client = createGatewayClient({ baseUrl: fixture.baseUrl })
    const login = await client.login({ password: fixture.password })
    expect(login.ok).toBe(true)
    expect(client.hasSession()).toBe(true)
    // Cookie 属性与真实网关一致(Path=/; HttpOnly; SameSite=Strict)
    const record = (client.jar as unknown as { get(name: string): { attributes: string } | null }).get('dsh_auth')
    expect(record).not.toBeNull()
    expect(record?.attributes).toMatch(/HttpOnly/)
    expect(record?.attributes).toMatch(/SameSite=Strict/)
    // 静默恢复:带 Cookie 打 settings
    const settings = await client.settings()
    expect(settings.ok).toBe(true)
    expect(await client.probeSession()).toBe(true)
  })

  it('错误密码 → 401 invalid-credentials(统一错误码)', async () => {
    const client = createGatewayClient({ baseUrl: fixture.baseUrl })
    const login = await client.login({ password: 'wrong-password-xxx' })
    expect(login.ok).toBe(false)
    if (!login.ok) {
      expect(login.status).toBe(401)
      expect(login.code).toBe('invalid-credentials')
      // 网关刻意不区分错误类型
      expect(login.message).not.toContain('密码')
    }
  })

  it('未认证访问 settings → 401 unauthenticated(JSON)', async () => {
    const client = createGatewayClient({ baseUrl: fixture.baseUrl })
    const settings = await client.settings()
    expect(settings.ok).toBe(false)
    if (!settings.ok) {
      expect(settings.status).toBe(401)
      expect(settings.code).toBe('unauthenticated')
    }
    expect(await client.probeSession()).toBe(false)
  })

  it('logout → 会话失效', async () => {
    const client = createGatewayClient({ baseUrl: fixture.baseUrl })
    await client.login({ password: fixture.password })
    const out = await client.logout()
    expect(out.ok).toBe(true)
    expect(client.hasSession()).toBe(false)
    expect(await client.probeSession()).toBe(false)
  })

  it('网络不可达 → network 失败(不抛异常)', async () => {
    const client = createGatewayClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1500 })
    const login = await client.login({ password: 'x' })
    expect(login.ok).toBe(false)
    if (!login.ok) expect(login.code).toBe('network')
  })
})
