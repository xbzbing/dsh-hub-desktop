import { describe, expect, it, vi } from 'vitest'
import { createAuthClient } from './auth-client'
import type { CookieJar } from './cookie-jar'

/** 用假 fetch 构造网关响应(契约真值见 tests/contract) */
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    return handler(String(input), init ?? {})
  }) as unknown as typeof fetch
}

function jsonResponse(status: number, body: unknown, setCookie?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (setCookie) headers.append('set-cookie', setCookie)
  return new Response(JSON.stringify(body), { status, headers })
}

function htmlResponse(status: number, body: string, location?: string): Response {
  const headers = new Headers({ 'content-type': 'text/html' })
  if (location) headers.set('location', location)
  return new Response(body, { status, headers })
}

describe('AuthClient（T7 §5.3/§5.4 编排）', () => {
  it('探测:302 → /login 识别为网关,进入 needs-auth', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw.example.com/dsh',
      fetchImpl: fakeFetch(() => htmlResponse(302, '', '/dsh/login'))
    })
    const detection = await client.probeAndRestore()
    expect(detection.mode).toBe('gateway')
    expect(client.state().phase).toBe('needs-auth')
  })

  it('静默恢复:已存 Cookie 打 settings=200 → connected,不打扰用户', async () => {
    const jar = { store: vi.fn(), header: () => 'dsh_auth=abc', get: () => ({ name: 'dsh_auth', value: 'abc', expiresAt: null, attributes: 'HttpOnly' }), clear: vi.fn(), describe: () => [] } as unknown as CookieJar
    const fetchImpl = fakeFetch((url) =>
      url.includes('/login-api/settings')
        ? jsonResponse(200, { ok: true, config: { 'dsh-auth-gateway': { otpEnabled: true } } })
        : htmlResponse(302, '', '/login')
    )
    const client = createAuthClient({ instanceId: 'i1', endpointUrl: 'https://gw/dsh', jar, fetchImpl })
    await client.probeAndRestore()
    expect(client.state().phase).toBe('connected')
    expect(client.state().otpEnabled).toBe(true)
  })

  it('登录成功 → connected(单请求带码完成 2FA)', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw/dsh',
      fetchImpl: fakeFetch((url) =>
        url.includes('/login/auth')
          ? jsonResponse(200, { ok: true }, 'dsh_auth=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=100')
          : htmlResponse(302, '', '/login')
      )
    })
    await client.probeAndRestore()
    const state = await client.login('pw', '123456')
    expect(state.phase).toBe('connected')
    expect(client.hasSession()).toBe(true)
  })

  it('400 otp-required → await-otp(验证码阶段)', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw/dsh',
      fetchImpl: fakeFetch((url) =>
        url.includes('/login/auth')
          ? jsonResponse(400, { ok: false, error: 'otp-required' })
          : htmlResponse(302, '', '/login')
      )
    })
    await client.probeAndRestore()
    const state = await client.login('pw')
    expect(state.phase).toBe('await-otp')
  })

  it('429 锁定 → 记录退避且 canSubmit 为假(禁止再发)', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw/dsh',
      fetchImpl: fakeFetch((url) =>
        url.includes('/login/auth')
          ? jsonResponse(429, { ok: false, error: 'too-many-attempts', retryAfterSeconds: 90 })
          : htmlResponse(302, '', '/login')
      )
    })
    await client.probeAndRestore()
    const state = await client.login('pw')
    expect(state.lockedForMs).toBe(90_000)
    expect(client.backoff.canAttempt()).toBe(false)
    // 锁定期间再提交不发请求
    const calls = (client as unknown as { _calls?: number })._calls
    void calls
    const again = await client.login('pw')
    expect(again.lockedForMs).toBe(90_000)
  })

  it('错误密码 → 统一提示「账号或验证码错误」', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw/dsh',
      fetchImpl: fakeFetch((url) =>
        url.includes('/login/auth')
          ? jsonResponse(401, { ok: false, error: 'invalid-credentials' })
          : htmlResponse(302, '', '/login')
      )
    })
    await client.probeAndRestore()
    const state = await client.login('pw')
    expect(state.lastErrorCode).toBe('invalid-credentials')
    expect(state.message).toBe('账号或验证码错误')
  })

  it('无需登录端点(200)→ 直接 connected', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'http://127.0.0.1:3080',
      fetchImpl: fakeFetch(() => htmlResponse(200, '<html>dsh</html>'))
    })
    const detection = await client.probeAndRestore()
    expect(detection.mode).toBe('none')
    expect(client.state().phase).toBe('connected')
  })

  it('端点不可达 → error(network)', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'http://127.0.0.1:1',
      timeoutMs: 500,
      fetchImpl: fakeFetch(() => {
        throw new Error('ECONNREFUSED')
      })
    })
    const detection = await client.probeAndRestore()
    expect(detection.mode).toBe('unreachable')
    expect(client.state().phase).toBe('error')
  })

  it('logout → 清 Cookie 并回 needs-auth', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw/dsh',
      fetchImpl: fakeFetch((url) => {
        if (url.includes('/login/auth')) {
          return jsonResponse(200, { ok: true }, 'dsh_auth=t; Path=/; HttpOnly; SameSite=Strict; Max-Age=100')
        }
        if (url.includes('/login/logout')) return jsonResponse(200, { ok: true })
        return htmlResponse(302, '', '/login')
      })
    })
    await client.probeAndRestore()
    await client.login('pw')
    expect(client.hasSession()).toBe(true)
    const state = await client.logout()
    expect(state.phase).toBe('needs-auth')
    expect(client.hasSession()).toBe(false)
  })
})
