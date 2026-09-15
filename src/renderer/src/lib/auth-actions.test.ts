import { describe, expect, it } from 'vitest'
import { showAuthActions } from './auth-actions'

describe('showAuthActions（登录/登出/凭据卡的统一可见性口径）', () => {
  it('ssh / http 且 authMode 非 none → 展示', () => {
    expect(showAuthActions({ transport: 'ssh', authMode: 'auto' })).toBe(true)
    expect(showAuthActions({ transport: 'ssh', authMode: 'gateway' })).toBe(true)
    expect(showAuthActions({ transport: 'http', authMode: 'auto' })).toBe(true)
  })

  it('local 实例不展示(BrowserAuth,无网关会话可登出)', () => {
    expect(showAuthActions({ transport: 'local', authMode: 'auto' })).toBe(false)
    expect(showAuthActions({ transport: 'local', authMode: 'gateway' })).toBe(false)
  })

  it('authMode=none 不展示(用户显式声明无需认证)', () => {
    expect(showAuthActions({ transport: 'ssh', authMode: 'none' })).toBe(false)
    expect(showAuthActions({ transport: 'http', authMode: 'none' })).toBe(false)
  })
})
