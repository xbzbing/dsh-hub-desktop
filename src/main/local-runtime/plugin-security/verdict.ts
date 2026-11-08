/**
 * 报告组装与判定：把各检查结果收敛成 pass / warn / blocked / unavailable。
 *
 * 口径（已与用户确认）：
 * - 任一 danger/blocked → blocked，不提供覆盖入口；
 * - 关键检查（完整性/内容）未完成 → unavailable，可「仍要安装」；
 * - 任一 warn → warn，可「仍要安装」；
 * - 只有 info/pass → pass。
 */
import type {
  PluginSecurityCheck,
  PluginSecurityFinding,
  PluginSecurityFacts,
  PluginSecurityReport
} from '@shared/contracts'

export interface ReportInput {
  spec: string
  checks: PluginSecurityCheck[]
  findings: PluginSecurityFinding[]
  facts: PluginSecurityFacts
  fingerprint: string | null
  essentialComplete: boolean
  partial: boolean
  durationMs: number
  checkedAt: string
}

function mergeFindings(findings: readonly PluginSecurityFinding[]): PluginSecurityFinding[] {
  const merged = new Map<string, PluginSecurityFinding>()
  for (const finding of findings) {
    const existing = merged.get(finding.code)
    if (existing === undefined) {
      merged.set(finding.code, {
        ...finding,
        evidence: [...finding.evidence].slice(0, 5)
      })
      continue
    }
    existing.count += finding.count
    for (const evidence of finding.evidence) {
      if (existing.evidence.length >= 5) break
      existing.evidence.push(evidence)
    }
    for (const ref of finding.refs) if (!existing.refs.includes(ref)) existing.refs.push(ref)
  }
  return [...merged.values()]
}

export function buildReport(input: ReportInput): PluginSecurityReport {
  const checks = input.checks
  const hardBlocked = checks.some((check) => check.level === 'danger' || check.level === 'blocked')
  const essentialIncomplete = checks.some(
    (check) => (check.id === 'integrity' || check.id === 'content') && check.level === 'skip'
  )
  const hasWarn = checks.some((check) => check.level === 'warn')

  const verdict = hardBlocked
    ? 'blocked'
    : essentialIncomplete
      ? 'unavailable'
      : hasWarn
        ? 'warn'
        : 'pass'

  return {
    spec: input.spec,
    verdict,
    checkedAt: input.checkedAt,
    durationMs: input.durationMs,
    fingerprint: input.fingerprint,
    essentialComplete: !essentialIncomplete,
    partial: input.partial,
    checks,
    findings: mergeFindings(input.findings),
    facts: input.facts
  }
}

/** 生成一项检查；params 只放展示用标量。 */
export function checkOf(
  id: PluginSecurityCheck['id'],
  level: PluginSecurityCheck['level'],
  code: string,
  params: PluginSecurityCheck['params'] = {},
  findings: readonly PluginSecurityFinding[] = []
): PluginSecurityCheck {
  return {
    id,
    level,
    code,
    params,
    findingCodes: findings.filter((finding) => finding.code !== '').map((finding) => finding.code)
  }
}
