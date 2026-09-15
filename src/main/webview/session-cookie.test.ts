import { describe, expect, it, vi } from 'vitest'
import {
  clearSessionCookie,
  DEFAULT_SESSION_COOKIE,
  originOf,
  sessionCookieUrl,
  type SessionCookieRemover
} from './session-cookie'

describe('session-cookie（T9 登出清理）', () => {
  it('url 规则与注入一致(basePath 不影响 path,仅影响页面 url)', () => {
    expect(sessionCookieUrl('https://gw', '/')).toBe('https://gw/')
    expect(sessionCookieUrl('https://gw/', '/dsh/')).toBe('https://gw/dsh/')
  })

  it('清理默认会话 Cookie 名', async () => {
    const remover: SessionCookieRemover = { remove: vi.fn(async () => undefined) }
    expect(await clearSessionCookie(remover, { origin: 'http://127.0.0.1:3080' })).toBe(true)
    expect(remover.remove).toHaveBeenCalledWith('http://127.0.0.1:3080/', DEFAULT_SESSION_COOKIE)
  })

  it('清理失败不抛(登出流程继续)', async () => {
    const remover: SessionCookieRemover = {
      remove: vi.fn(async () => {
        throw new Error('partition 不可用')
      })
    }
    expect(await clearSessionCookie(remover, { origin: 'http://h' })).toBe(false)
  })

  it('originOf 提取 origin(非法返回 null)', () => {
    expect(originOf('http://127.0.0.1:3080/dsh/')).toBe('http://127.0.0.1:3080')
    expect(originOf('not a url')).toBeNull()
  })
})
