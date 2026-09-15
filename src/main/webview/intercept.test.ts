import { describe, expect, it } from 'vitest'
import { classifyAuthSignal, locationPathname } from './intercept'

const headers = (extra: Record<string, string> = {}): Record<string, string> => extra

describe('intercept（§6.3 401/302 判定）', () => {
  it('302 → /login = 会话失效', () => {
    expect(
      classifyAuthSignal({ statusCode: 302, headers: headers({ location: '/login' }) })
    ).toBe('session-expired')
  })

  it('basePath 下的 302 → /dsh/login = 会话失效;其他路径不算', () => {
    expect(
      classifyAuthSignal({ statusCode: 302, headers: headers({ location: '/dsh/login' }) }, '/dsh')
    ).toBe('session-expired')
    expect(
      classifyAuthSignal({ statusCode: 302, headers: headers({ location: '/other/login' }) }, '/dsh')
    ).toBeNull()
  })

  it('带查询串/尾斜杠的登录重定向仍识别', () => {
    expect(
      classifyAuthSignal({ statusCode: 302, headers: headers({ location: '/login?next=/a' }) })
    ).toBe('session-expired')
    expect(
      classifyAuthSignal({ statusCode: 302, headers: headers({ location: '/login/' }) })
    ).toBe('session-expired')
  })

  it('401 JSON unauthenticated = 会话失效', () => {
    expect(
      classifyAuthSignal({
        statusCode: 401,
        headers: headers({ 'content-type': 'application/json' }),
        body: '{"ok":false,"error":"unauthenticated"}'
      })
    ).toBe('session-expired')
  })

  it('401 otp-required / onboarding-required 分别映射', () => {
    expect(
      classifyAuthSignal({ statusCode: 401, headers: {}, body: '{"error":"otp-required"}' })
    ).toBe('needs-otp')
    expect(
      classifyAuthSignal({ statusCode: 401, headers: {}, body: '{"error":"onboarding-required"}' })
    ).toBe('needs-onboarding')
  })

  it('302 到非登录路径 / 200 / 401 其他 error 均不触发', () => {
    expect(classifyAuthSignal({ statusCode: 302, headers: headers({ location: '/home' }) })).toBeNull()
    expect(classifyAuthSignal({ statusCode: 200, headers: {} })).toBeNull()
    expect(classifyAuthSignal({ statusCode: 401, headers: {}, body: '{"error":"other"}' })).toBeNull()
    expect(classifyAuthSignal({ statusCode: 404, headers: {} })).toBeNull()
  })

  it('头名大小写不敏感;数组头取首个', () => {
    expect(
      classifyAuthSignal({ statusCode: 302, headers: { Location: ['/login'] } })
    ).toBe('session-expired')
  })

  it('locationPathname 归一化相对/绝对', () => {
    expect(locationPathname('/a/b')).toBe('/a/b')
    expect(locationPathname('https://gw.example.com/dsh/login')).toBe('/dsh/login')
    expect(locationPathname(null)).toBe('')
  })
})
