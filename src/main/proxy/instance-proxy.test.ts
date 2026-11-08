import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))

import type { HttpInstance } from '@shared/contracts'
import { createInstanceProxy } from './instance-proxy'

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'

function instance(proxy: HttpInstance['proxy']): HttpInstance {
  return {
    id: INSTANCE_ID,
    name: 'proxy-test',
    transport: 'http',
    authMode: 'auto',
    endpointUrl: 'https://target.invalid',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    proxy
  }
}

function fakeSession(): {
  setProxy: ReturnType<typeof vi.fn>
  closeAllConnections: ReturnType<typeof vi.fn>
} {
  return {
    setProxy: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined)
  }
}

describe('createInstanceProxy', () => {
  it('把 HTTP / SOCKS5 代理落到实例 session，配置未变时不重复设置', async () => {
    const target = fakeSession()
    const proxy = createInstanceProxy({
      getProxyPassword: async () => null,
      sessionFor: () => target as never
    })
    const http = instance({ type: 'http', host: '127.0.0.1', port: 7897 })
    await proxy.apply(http)
    expect(target.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:7897',
      proxyBypassRules: '<-loopback>'
    })
    await proxy.apply(http)
    expect(target.setProxy).toHaveBeenCalledTimes(1)

    await proxy.apply(instance({ type: 'socks5', host: '::1', port: 1080 }))
    expect(target.setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://[::1]:1080',
      proxyBypassRules: '<-loopback>'
    })
    expect(target.setProxy).toHaveBeenCalledTimes(2)
  })

  it('代理规则不变但凭据变化时关闭旧连接池', async () => {
    let password = 'old-secret'
    const target = fakeSession()
    const proxy = createInstanceProxy({
      getProxyPassword: async () => password,
      sessionFor: () => target as never
    })
    const http = instance({ type: 'http', host: '127.0.0.1', port: 7897, username: 'alice' })
    await proxy.apply(http)
    expect(target.setProxy).toHaveBeenCalledTimes(1)
    expect(target.closeAllConnections).toHaveBeenCalledTimes(1)

    // 相同规则、相同密码：不重建连接。
    await proxy.apply(http)
    expect(target.closeAllConnections).toHaveBeenCalledTimes(1)

    // 相同规则、不同密码：必须关闭旧连接，让新密码生效。
    password = 'new-secret'
    await proxy.apply(http)
    expect(target.setProxy).toHaveBeenCalledTimes(1)
    expect(target.closeAllConnections).toHaveBeenCalledTimes(2)
  })

  it('直接取 fetch 时换密码同样关闭旧连接', async () => {
    let password = 'old-secret'
    const target = fakeSession()
    const proxy = createInstanceProxy({
      getProxyPassword: async () => password,
      sessionFor: () => target as never
    })
    const http = instance({ type: 'http', host: '127.0.0.1', port: 7897, username: 'alice' })
    await proxy.apply(http)
    expect(target.closeAllConnections).toHaveBeenCalledTimes(1)
    password = 'new-secret'
    await proxy.fetchFor(http)
    expect(target.closeAllConnections).toHaveBeenCalledTimes(2)
  })

  it('清空代理时显式回到 direct', async () => {
    const target = fakeSession()
    const proxy = createInstanceProxy({
      getProxyPassword: async () => null,
      sessionFor: () => target as never
    })
    await proxy.apply(instance({ type: 'http', host: 'proxy', port: 8080 }))
    await proxy.apply(instance(undefined))
    expect(target.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
  })

  it('代理认证按 session 找回实例，并从 vault 读取密码', async () => {
    const target = fakeSession()
    const proxy = createInstanceProxy({
      getProxyPassword: async () => 'secret',
      sessionFor: () => target as never
    })
    await proxy.apply(instance({ type: 'http', host: 'proxy', port: 8080, username: 'alice' }))
    const preventDefault = vi.fn()
    const callback = vi.fn()
    const handled = proxy.handleLogin(
      { preventDefault },
      { session: target } as never,
      { isProxy: true },
      callback
    )
    expect(handled).toBe(true)
    expect(preventDefault).toHaveBeenCalled()
    expect(callback).toHaveBeenCalledWith('alice', 'secret')
  })

  it('无凭据或非代理认证时不拦截默认行为', async () => {
    const target = fakeSession()
    const proxy = createInstanceProxy({
      // 空串视同未保存密码，不能拿去代理认证。
      getProxyPassword: async () => '',
      sessionFor: () => target as never
    })
    await proxy.apply(instance({ type: 'http', host: 'proxy', port: 8080, username: 'alice' }))
    const event = { preventDefault: vi.fn() }
    expect(proxy.handleLogin(event, { session: target } as never, { isProxy: true }, vi.fn())).toBe(
      false
    )
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(
      proxy.handleLogin(event, { session: target } as never, { isProxy: false }, vi.fn())
    ).toBe(false)
  })
})
