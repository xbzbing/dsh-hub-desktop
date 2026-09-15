import { describe, expect, it } from 'vitest'
import type { VaultStatusSnapshot } from '@shared/contracts'
import { canSubmitPolicy, effectivePolicy, policyReady } from './vault-policy'

const snapshot = (policies: Record<string, { rememberPassword: boolean; rememberSession: boolean }>): VaultStatusSnapshot => ({
  available: true,
  degraded: false,
  rememberedInstances: Object.keys(policies),
  policies
})

describe('vault-policy（复审 F1/F2/F3 的防线）', () => {
  it('快照到达前不可提交(否则会用兜底全 false 覆盖真实策略,静默删凭据)', () => {
    expect(policyReady(null)).toBe(false)
    expect(canSubmitPolicy(null, false)).toBe(false)
    expect(canSubmitPolicy(snapshot({}), false)).toBe(true)
    expect(canSubmitPolicy(snapshot({}), true)).toBe(false)
  })

  it('已设策略但**尚无凭据**时仍能读到策略(复审 F1:这正是首次使用流程)', () => {
    // 用户勾了「记住密码」但还没登录成功 —— 此时 rememberedInstances 为空
    const status = snapshot({ i1: { rememberPassword: true, rememberSession: false } })
    expect(status.rememberedInstances).toEqual(['i1'])
    expect(effectivePolicy(status, 'i1')).toEqual({
      rememberPassword: true,
      rememberSession: false
    })
    // 旧实现按 rememberedIds 下发策略 → 这里会错误地读到未勾选,随后被覆盖(复审 F2)
  })

  it('未设策略的实例返回兜底值;快照为 null 同样返回兜底值', () => {
    expect(effectivePolicy(snapshot({}), 'i1')).toEqual({
      rememberPassword: false,
      rememberSession: false
    })
    expect(effectivePolicy(null, 'i1')).toEqual({
      rememberPassword: false,
      rememberSession: false
    })
  })

  it('多实例各自独立(不会串味)', () => {
    const status = snapshot({
      a: { rememberPassword: true, rememberSession: false },
      b: { rememberPassword: false, rememberSession: true }
    })
    expect(effectivePolicy(status, 'a').rememberPassword).toBe(true)
    expect(effectivePolicy(status, 'b').rememberPassword).toBe(false)
    expect(effectivePolicy(status, 'b').rememberSession).toBe(true)
  })
})
