import { describe, expect, it, vi } from 'vitest'
import {
  cookieUrlFor,
  importSessionCookie,
  prepareInstanceView,
  toCookieRecord,
  toExpirationDate,
  type CookieSetter
} from './cookie-import'

describe('cookie-import（ Cookie 双写）', () => {
  it('Cookie 属性与真实网关一致(Path=/; HttpOnly; SameSite=strict; 无 Secure)', () => {
    const record = toCookieRecord({
      origin: 'https://gw.example.com',
      basePath: '/dsh',
      cookie: { name: 'dsh_auth', value: 'tok', expiresAt: 1_800_000_000_000 }
    })
    expect(record).toMatchObject({
      name: 'dsh_auth',
      value: 'tok',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      expirationDate: 1_800_000_000
    })
    // basePath 不改变 Cookie 路径,但 url 落在实例 origin 下
    expect(record.url).toBe('https://gw.example.com/dsh/')
  })

  it('无过期时间(会话 Cookie)不带 expirationDate', () => {
    const record = toCookieRecord({
      origin: 'http://127.0.0.1:3080',
      cookie: { name: 'dsh_auth', value: 't', expiresAt: null }
    })
    expect(record.expirationDate).toBeUndefined()
    expect(record.url).toBe('http://127.0.0.1:3080/')
  })

  it('cookieUrlFor 处理尾斜杠与根 basePath', () => {
    expect(cookieUrlFor('https://gw/', '/')).toBe('https://gw/')
    expect(cookieUrlFor('https://gw', '/dsh/')).toBe('https://gw/dsh/')
  })

  it('注入失败不抛异常(返回 false,交由拦截层重登)', async () => {
    const setter: CookieSetter = {
      set: vi.fn(async () => {
        throw new Error('partition 不可用')
      })
    }
    const ok = await importSessionCookie(setter, {
      origin: 'http://127.0.0.1:3080',
      cookie: { name: 'dsh_auth', value: 'x', expiresAt: null }
    })
    expect(ok).toBe(false)
  })

  it('expirationDate 换算:毫秒输入按 秒 写出;秒级输入不会被写成 1970', () => {
    // 2026-09 的毫秒时间戳
    const ms = 1_789_000_000_000
    expect(toExpirationDate(ms)).toBe(1_789_000_000)
    // 同一个时刻的秒级输入(误传)应被识别并换算成毫秒,而不是当作 1970 前的值
    expect(toExpirationDate(1_789_000_000)).toBe(1_789_000_000)
    const record = toCookieRecord({
      origin: 'http://127.0.0.1:3080',
      cookie: { name: 'dsh_auth', value: 'x', expiresAt: 1_789_000_000 }
    })
    expect(record.expirationDate).toBe(1_789_000_000)
  })

  it('顺序纪律:先注入 Cookie 再 loadURL', async () => {
    const order: string[] = []
    const setter: CookieSetter = {
      set: vi.fn(async () => {
        order.push('set-cookie')
      })
    }
    await prepareInstanceView(
      setter,
      {
        origin: 'http://127.0.0.1:3080',
        basePath: '/dsh',
        cookie: { name: 'dsh_auth', value: 'tok', expiresAt: null }
      },
      () => {
        order.push('load')
      }
    )
    expect(order).toEqual(['set-cookie', 'load'])
  })

  it('加载动作由调用方闭包提供(不重建 URL,保留 ?token=)', async () => {
    const loaded: string[] = []
    await prepareInstanceView(
      { set: vi.fn(async () => undefined) },
      {
        origin: 'http://127.0.0.1:3080',
        cookie: { name: 'dsh_auth', value: 'tok', expiresAt: null }
      },
      () => {
        loaded.push('http://127.0.0.1:3080/?token=abc')
      }
    )
    expect(loaded).toEqual(['http://127.0.0.1:3080/?token=abc'])
  })

  it('无会话(空值)时跳过注入但仍 loadURL(browser-auth/无需登录场景)', async () => {
    const setter: CookieSetter = { set: vi.fn(async () => undefined) }
    const load = vi.fn()
    const injected = await prepareInstanceView(
      setter,
      { origin: 'http://127.0.0.1:3080', cookie: { name: 'dsh_auth', value: '', expiresAt: null } },
      load
    )
    expect(injected).toBe(false)
    expect(setter.set).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
