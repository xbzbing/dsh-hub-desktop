import { describe, expect, it } from 'vitest'
import {
  ProxyConfigSchema,
  ProxyInputSchema,
  proxyAddress,
  proxyConfigOf,
  proxyRulesFor
} from './contracts-proxy'

describe('代理配置 schema 与格式化', () => {
  it('接受 HTTP / SOCKS5、IPv4、域名与方括号 IPv6', () => {
    expect(ProxyConfigSchema.parse({ type: 'http', host: '127.0.0.1', port: 7897 })).toEqual({
      type: 'http',
      host: '127.0.0.1',
      port: 7897
    })
    expect(ProxyConfigSchema.parse({ type: 'socks5', host: '[::1]', port: 1080 })).toEqual({
      type: 'socks5',
      host: '[::1]',
      port: 1080
    })
  })

  it('拒绝带端口、userinfo、空白或越界端口的主机', () => {
    for (const host of ['127.0.0.1:7897', 'user:pass@proxy', 'bad host', 'http://proxy']) {
      expect(ProxyConfigSchema.safeParse({ type: 'http', host, port: 8080 }).success).toBe(false)
    }
    expect(ProxyConfigSchema.safeParse({ type: 'http', host: 'proxy', port: 0 }).success).toBe(
      false
    )
    expect(ProxyConfigSchema.safeParse({ type: 'http', host: 'proxy', port: 65536 }).success).toBe(
      false
    )
  })

  it('SOCKS5 拒绝用户名/密码：浏览器只提供 no-auth 握手', () => {
    expect(
      ProxyConfigSchema.safeParse({
        type: 'socks5',
        host: 'proxy',
        port: 1080,
        username: 'u'
      }).success
    ).toBe(false)
    expect(
      ProxyInputSchema.safeParse({
        type: 'socks5',
        host: 'proxy',
        port: 1080,
        username: 'u',
        password: 'secret'
      }).success
    ).toBe(false)
    expect(
      ProxyInputSchema.safeParse({
        type: 'socks5',
        host: 'proxy',
        port: 1080,
        password: 'secret'
      }).success
    ).toBe(false)
    // 显式清空密码仍然允许（更新路径用它清掉旧值）。
    expect(
      ProxyInputSchema.safeParse({
        type: 'socks5',
        host: 'proxy',
        port: 1080,
        password: null
      }).success
    ).toBe(true)
  })

  it('HTTP 代理密码必须同时有用户名', () => {
    expect(
      ProxyInputSchema.safeParse({
        type: 'http',
        host: 'proxy',
        port: 8080,
        password: 'secret'
      }).success
    ).toBe(false)
  })

  it('ProxyInput 允许密码，ProxyConfig 不允许密码落进注册表', () => {
    expect(
      ProxyInputSchema.parse({
        type: 'http',
        host: 'proxy',
        port: 8080,
        username: 'u',
        password: 'secret'
      })
    ).toMatchObject({ password: 'secret' })
    expect(
      ProxyConfigSchema.safeParse({
        type: 'http',
        host: 'proxy',
        port: 8080,
        password: 'secret'
      }).success
    ).toBe(false)
  })

  it('proxyRulesFor 生成代理规则，IPv6 补方括号', () => {
    expect(proxyRulesFor({ type: 'http', host: 'proxy', port: 8080 })).toBe('http://proxy:8080')
    expect(proxyRulesFor({ type: 'socks5', host: '::1', port: 1080 })).toBe('socks5://[::1]:1080')
    expect(proxyRulesFor(null)).toBeNull()
    expect(proxyAddress({ type: 'http', host: '127.0.0.1', port: 7897 })).toBe(
      'http://127.0.0.1:7897'
    )
  })

  it('proxyConfigOf 剥掉密码并 trim 主机/用户名', () => {
    expect(
      proxyConfigOf({
        type: 'http',
        host: ' proxy ',
        port: 8080,
        username: ' u ',
        password: 'secret'
      })
    ).toEqual({ type: 'http', host: 'proxy', port: 8080, username: 'u' })
    expect(proxyConfigOf(null)).toBeNull()
  })
})
