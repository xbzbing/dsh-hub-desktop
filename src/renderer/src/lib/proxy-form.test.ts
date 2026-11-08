import { describe, expect, it } from 'vitest'
import { buildProxyPatch, proxyDraftOf, switchProxyType } from './proxy-form'

const EMPTY = {
  type: 'none' as const,
  host: '',
  port: '8080',
  username: '',
  password: '',
  clearPassword: false
}

describe('proxyDraftOf', () => {
  it('无代理时给出「不使用代理」草稿', () => {
    expect(proxyDraftOf(null)).toEqual(EMPTY)
    expect(proxyDraftOf(undefined)).toEqual(EMPTY)
  })

  it('有代理时回填类型、主机、端口与用户名，密码留空', () => {
    expect(
      proxyDraftOf({ type: 'http', host: '127.0.0.1', port: 7897, username: 'alice' })
    ).toEqual({
      type: 'http',
      host: '127.0.0.1',
      port: '7897',
      username: 'alice',
      password: '',
      clearPassword: false
    })
  })
})

describe('switchProxyType', () => {
  it('切到 SOCKS5 清空凭据', () => {
    const draft = {
      type: 'http' as const,
      host: 'h',
      port: '8080',
      username: 'alice',
      password: 'secret',
      clearPassword: true
    }
    expect(switchProxyType(draft, 'socks5')).toEqual({
      type: 'socks5',
      host: 'h',
      port: '8080',
      username: '',
      password: '',
      clearPassword: false
    })
  })

  it('端口未填时按类型给默认值，已填则保留', () => {
    expect(switchProxyType({ ...EMPTY, port: '' }, 'http').port).toBe('8080')
    expect(switchProxyType({ ...EMPTY, port: '' }, 'socks5').port).toBe('1080')
    expect(switchProxyType({ ...EMPTY, port: '9999' }, 'http').port).toBe('9999')
  })
})

describe('buildProxyPatch', () => {
  it('none → null（清空代理）', () => {
    expect(buildProxyPatch(EMPTY, { type: 'http', host: 'h', port: 1 })).toEqual({
      ok: true,
      proxy: null
    })
  })

  it('主机为空或端口非法时给出文案 key', () => {
    expect(buildProxyPatch({ ...EMPTY, type: 'http' }, null)).toEqual({
      ok: false,
      messageKey: 'edit.proxyRequired'
    })
    for (const port of ['', '0', '65536', 'abc', '80.5']) {
      expect(buildProxyPatch({ ...EMPTY, type: 'socks5', host: 'h', port }, null)).toEqual({
        ok: false,
        messageKey: 'edit.proxyPortInvalid'
      })
    }
  })

  it('无认证代理只带类型/主机/端口', () => {
    expect(
      buildProxyPatch(
        { ...EMPTY, type: 'socks5', host: ' ::1 ', port: '1080', username: 'x' },
        null
      )
    ).toEqual({ ok: true, proxy: { type: 'socks5', host: '::1', port: 1080 } })
  })

  it('HTTP 代理：密码留空沿用已保存密码，用户名不变时不要求重填', () => {
    const existing = { type: 'http' as const, host: 'h', port: 8080, username: 'alice' }
    expect(
      buildProxyPatch(
        { ...EMPTY, type: 'http', host: 'h', port: '8080', username: 'alice' },
        existing
      )
    ).toEqual({
      ok: true,
      proxy: { type: 'http', host: 'h', port: 8080, username: 'alice' }
    })
  })

  it('HTTP 代理：用户名变化且未填密码时拒绝', () => {
    const existing = { type: 'http' as const, host: 'h', port: 8080, username: 'alice' }
    expect(
      buildProxyPatch(
        { ...EMPTY, type: 'http', host: 'h', port: '8080', username: 'bob' },
        existing
      )
    ).toEqual({ ok: false, messageKey: 'edit.proxyPasswordRequired' })
  })

  it('HTTP 代理：填了密码则写入', () => {
    expect(
      buildProxyPatch(
        { ...EMPTY, type: 'http', host: 'h', port: '8080', username: 'bob', password: 's' },
        null
      )
    ).toEqual({
      ok: true,
      proxy: { type: 'http', host: 'h', port: 8080, username: 'bob', password: 's' }
    })
  })

  it('HTTP 代理：无用户名却填密码时拒绝', () => {
    expect(
      buildProxyPatch({ ...EMPTY, type: 'http', host: 'h', port: '8080', password: 's' }, null)
    ).toEqual({ ok: false, messageKey: 'edit.proxyUsernameRequired' })
  })

  it('HTTP 代理：显式清空密码与填写密码互斥', () => {
    const draft = {
      ...EMPTY,
      type: 'http' as const,
      host: 'h',
      port: '8080',
      username: 'alice',
      password: 's',
      clearPassword: true
    }
    expect(buildProxyPatch(draft, null)).toEqual({
      ok: false,
      messageKey: 'edit.proxyPasswordClearConflict'
    })
  })

  it('HTTP 代理：保留用户名时勾选清空密码会被拒绝', () => {
    const existing = { type: 'http' as const, host: 'h', port: 8080, username: 'alice' }
    expect(
      buildProxyPatch(
        { ...EMPTY, type: 'http', host: 'h', port: '8080', username: 'alice', clearPassword: true },
        existing
      )
    ).toEqual({ ok: false, messageKey: 'edit.proxyPasswordClearConflict' })
  })

  it('HTTP 代理：移除用户名后清空密码，提交不含用户名的配置', () => {
    const existing = { type: 'http' as const, host: 'h', port: 8080, username: 'alice' }
    expect(
      buildProxyPatch(
        { ...EMPTY, type: 'http', host: 'h', port: '8080', clearPassword: true },
        existing
      )
    ).toEqual({ ok: true, proxy: { type: 'http', host: 'h', port: 8080, password: null } })
  })

  it('HTTP 代理改为无用户名（不再认证）时清空用户名', () => {
    const existing = { type: 'http' as const, host: 'h', port: 8080, username: 'alice' }
    expect(buildProxyPatch({ ...EMPTY, type: 'http', host: 'h', port: '8080' }, existing)).toEqual({
      ok: true,
      proxy: { type: 'http', host: 'h', port: 8080 }
    })
  })
})
