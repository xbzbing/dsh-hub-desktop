import { describe, expect, it } from 'vitest'
import type { PluginSecurityCheck, PluginSecurityReport } from '@shared/contracts'
import { securityHardBlocked, securityNeedsAcknowledgement } from './plugin-security'

function check(
  id: PluginSecurityCheck['id'],
  level: PluginSecurityCheck['level'],
  code: string
): PluginSecurityCheck {
  return { id, level, code, params: {}, findingCodes: [] }
}

function report(
  verdict: PluginSecurityReport['verdict'],
  checks: PluginSecurityCheck[] = []
): Pick<PluginSecurityReport, 'verdict' | 'checks'> {
  return { verdict, checks }
}

describe('安全检查放行口径', () => {
  it('结构性失败没有覆盖入口', () => {
    for (const level of ['blocked', 'danger'] as const) {
      const blocked = report('blocked', [check('integrity', level, 'integrity.mismatch')])
      expect(securityHardBlocked(blocked)).toBe(true)
      expect(securityNeedsAcknowledgement(blocked)).toBe(false)
    }
  })

  it('启发式规则给出的 blocked 可确认后安装', () => {
    const overridable = report('blocked', [
      check('integrity', 'pass', 'integrity.ok'),
      check('content', 'danger', 'content.credential-exfil')
    ])
    expect(securityHardBlocked(overridable)).toBe(false)
    expect(securityNeedsAcknowledgement(overridable)).toBe(true)
  })

  it('warn / unavailable 需要确认，pass 不需要', () => {
    expect(securityNeedsAcknowledgement(report('warn'))).toBe(true)
    expect(securityNeedsAcknowledgement(report('unavailable'))).toBe(true)
    expect(securityNeedsAcknowledgement(report('pass'))).toBe(false)
  })

  it('取数失败按需要确认处理，无报告不需要', () => {
    expect(securityNeedsAcknowledgement(null, true)).toBe(true)
    expect(securityNeedsAcknowledgement(null, false)).toBe(false)
    expect(securityHardBlocked(null)).toBe(false)
  })
})
