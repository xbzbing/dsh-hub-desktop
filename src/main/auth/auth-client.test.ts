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
  it('探测:302 → /login 识别为网关,进入 await-credentials(R6 设计边)', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw.example.com/dsh',
      fetchImpl: fakeFetch(() => htmlResponse(302, '', '/dsh/login'))
    })
    const detection = await client.probeAndRestore()
    expect(detection.mode).toBe('gateway')
    expect(client.state().phase).toBe('await-credentials')
  })

  it('探测:302 → /otp/verify 消费 gatewayEvidence,进入 await-otp(评审 R1)', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw.example.com/dsh',
      fetchImpl: fakeFetch(() => htmlResponse(302, '', '/dsh/otp/verify'))
    })
    const detection = await client.probeAndRestore()
    expect(detection.gatewayEvidence).toBe('otp-page')
    // 旧实现丢弃该证据,一律退化到 await-credentials
    expect(client.state().phase).toBe('await-otp')
    expect(client.state().otpEnabled).toBe(true)
  })

  it('探测:302 → /onboarding 消费 gatewayEvidence,置 needsOnboarding(评审 R1)', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw.example.com/dsh',
      fetchImpl: fakeFetch(() => htmlResponse(302, '', '/dsh/onboarding'))
    })
    const detection = await client.probeAndRestore()
    expect(detection.gatewayEvidence).toBe('onboarding')
    expect(client.state().needsOnboarding).toBe(true)
    expect(client.state().phase).toBe('await-credentials')
  })

  it('探测:302 → /login 仍是 await-credentials(证据为 login-page 时不误判)', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw.example.com/dsh',
      fetchImpl: fakeFetch(() => htmlResponse(302, '', '/dsh/login'))
    })
    const detection = await client.probeAndRestore()
    expect(detection.gatewayEvidence).toBe('login-page')
    expect(client.state().phase).toBe('await-credentials')
    expect(client.state().needsOnboarding).toBe(false)
  })

  it('D1:探测带上已有会话 Cookie —— 半认证会话能看到 otp/onboarding 两种状态', async () => {
    const probes: Array<string | null> = []
    const jar = {
      store: vi.fn(),
      header: () => 'dsh_auth=half-authenticated',
      get: () => ({ name: 'dsh_auth', value: 'half-authenticated', expiresAt: null, attributes: '' }),
      clear: vi.fn(),
      describe: () => []
    } as unknown as CookieJar
    const fetchImpl = fakeFetch((url, init) => {
      if (url.includes('/login-api/settings')) {
        // 会话有效但 OTP 未验:settings 返回 401 otp-required
        return jsonResponse(401, { ok: false, error: 'otp-required' })
      }
      const cookie = new Headers(init.headers).get('cookie')
      probes.push(cookie)
      return cookie
        ? htmlResponse(302, '', '/dsh/otp/verify')
        : htmlResponse(302, '', '/dsh/login')
    })

    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw.example.com/dsh',
      jar,
      fetchImpl
    })
    const detection = await client.probeAndRestore()

    // 关键:页面探测必须带会话头,否则网关第一道门禁永远返回 302→/login
    expect(probes).toEqual(['dsh_auth=half-authenticated'])
    expect(detection.gatewayEvidence).toBe('otp-page')
    expect(client.state().phase).toBe('await-otp')
    // D2:otp-required 说明会话有效(只完成一半认证),绝不能清罐
    expect(jar.clear).not.toHaveBeenCalled()
    expect(client.hasSession()).toBe(true)
  })

  it('D2:settings 401 为 unauthenticated 时才清罐', async () => {
    const jar = {
      store: vi.fn(),
      header: () => 'dsh_auth=stale',
      get: () => ({ name: 'dsh_auth', value: 'stale', expiresAt: null, attributes: '' }),
      clear: vi.fn(),
      describe: () => []
    } as unknown as CookieJar
    const fetchImpl = fakeFetch((url) =>
      url.includes('/login-api/settings')
        ? jsonResponse(401, { ok: false, error: 'unauthenticated' })
        : htmlResponse(302, '', '/dsh/login')
    )
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw.example.com/dsh',
      jar,
      fetchImpl
    })
    await client.probeAndRestore()
    expect(jar.clear).toHaveBeenCalledTimes(1)
    expect(client.state().phase).toBe('await-credentials')
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
    // 注入固定时钟:锁定剩余量由 backoff 单一来源派生,真实 Date.now 在并行跑时会漂移
    const now = 1_000_000
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw/dsh',
      now: () => now,
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
    void now
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

describe('T7 评审回归防线', () => {
  it('R1:429 锁定窗口过后自动解锁(单一计时来源,不再永久锁定)', async () => {
    let now = 1_000_000
    const fetchImpl = vi.fn(async (input: string | URL) =>
      String(input).includes('/login/auth')
        ? jsonResponse(429, { ok: false, error: 'too-many-attempts', retryAfterSeconds: 90 })
        : htmlResponse(302, '', '/login')
    ) as unknown as typeof fetch
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw/dsh',
      fetchImpl,
      now: () => now
    })
    await client.probeAndRestore()
    const locked = await client.login('pw')
    expect(locked.lockedForMs).toBe(90_000)

    // 窗口未过:再提交仍被拒,且不新增请求
    const callsBefore = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    await client.login('pw')
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsBefore)

    // 推进 91s → 自动解锁(此前会永久锁定:Critical)
    now += 91_000
    expect(client.backoff.canAttempt()).toBe(true)
    expect(client.state().lockedForMs).toBe(0)
    await client.login('pw')
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(
      callsBefore
    )
  })

  it('R2:锁定期间不发送任何认证请求(以 fetch 调用次数断言,而非死代码)', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) =>
      String(input).includes('/login/auth')
        ? jsonResponse(429, { ok: false, error: 'rate-limited' })
        : htmlResponse(302, '', '/login')
    ) as unknown as typeof fetch
    const client = createAuthClient({ instanceId: 'i1', endpointUrl: 'https://gw/dsh', fetchImpl })
    await client.probeAndRestore()
    await client.login('pw')
    const after429 = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    await client.login('pw')
    await client.login('pw')
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(after429)
  })

  it('R3:客户端请求强制 redirect:manual(含 /login/auth 自身请求)', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, init })
      if (url.includes('/login/auth')) {
        return jsonResponse(200, { ok: true }, 'dsh_auth=t; Path=/; HttpOnly; SameSite=Strict; Max-Age=100')
      }
      return htmlResponse(302, '', '/login')
    }) as unknown as typeof fetch
    const client = createAuthClient({ instanceId: 'i1', endpointUrl: 'https://gw/dsh', fetchImpl })
    await client.probeAndRestore()
    await client.login('pw')
    // 至少一次请求打到 /login/auth(否则本用例只观测到探测请求,无法锁住 client 自身行为)
    expect(seen.some((item) => item.url.includes('/login/auth'))).toBe(true)
    for (const item of seen) expect(item.init?.redirect).toBe('manual')
  })

  it('R5:验证码阶段复用同一次密码经 /login/auth 提交(而非分步 /otp/verify)', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/login/auth')) {
        return urls.filter((item) => item.includes('/login/auth')).length === 1
          ? jsonResponse(400, { ok: false, error: 'otp-required' })
          : jsonResponse(200, { ok: true }, 'dsh_auth=t; Path=/; HttpOnly; SameSite=Strict; Max-Age=100')
      }
      return htmlResponse(302, '', '/login')
    }) as unknown as typeof fetch
    const client = createAuthClient({ instanceId: 'i1', endpointUrl: 'https://gw/dsh', fetchImpl })
    await client.probeAndRestore()
    expect((await client.login('pw')).phase).toBe('await-otp')
    // 复用同一密码 + 验证码 → 单请求完成
    const state = await client.login('pw', '123456')
    expect(state.phase).toBe('connected')
    expect(urls.some((url) => url.includes('/otp/verify'))).toBe(false)
  })

  it('R6:探测为网关且无会话 → await-credentials(密码屏可达)', async () => {
    const client = createAuthClient({
      instanceId: 'i1',
      endpointUrl: 'https://gw/dsh',
      fetchImpl: fakeFetch(() => htmlResponse(302, '', '/login'))
    })
    await client.probeAndRestore()
    expect(client.state().phase).toBe('await-credentials')
  })
})
