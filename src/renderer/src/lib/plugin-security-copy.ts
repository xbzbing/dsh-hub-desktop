import type { Translator } from '@shared/i18n'
import type { MessageKey } from '@shared/i18n/messages'
import type {
  PluginSecurityCheck,
  PluginSecurityLevel,
  PluginSecurityVerdict
} from '@shared/contracts'

const LEVEL_KEYS: Record<PluginSecurityLevel, MessageKey> = {
  pass: 'detail.plugin.security.level.pass',
  info: 'detail.plugin.security.level.info',
  warn: 'detail.plugin.security.level.warn',
  danger: 'detail.plugin.security.level.danger',
  blocked: 'detail.plugin.security.level.blocked',
  skip: 'detail.plugin.security.level.skip'
}

const CHECK_KEYS: Record<PluginSecurityCheck['id'], MessageKey> = {
  source: 'detail.plugin.security.check.source',
  integrity: 'detail.plugin.security.check.integrity',
  reputation: 'detail.plugin.security.check.reputation',
  name: 'detail.plugin.security.check.name',
  scripts: 'detail.plugin.security.check.scripts',
  content: 'detail.plugin.security.check.content',
  dependencies: 'detail.plugin.security.check.dependencies',
  vulnerabilities: 'detail.plugin.security.check.vulnerabilities'
}

const VERDICT_KEYS: Record<PluginSecurityVerdict, MessageKey> = {
  pass: 'detail.plugin.security.verdict.pass',
  warn: 'detail.plugin.security.verdict.warn',
  blocked: 'detail.plugin.security.verdict.blocked',
  unavailable: 'detail.plugin.security.verdict.unavailable',
  disabled: 'detail.plugin.security.verdict.disabled'
}

const CODE_KEYS: Record<string, MessageKey> = {
  'source.npm': 'detail.plugin.security.code.source.npm',
  'source.mirror': 'detail.plugin.security.code.source.mirror',
  'source.publisher.changed': 'detail.plugin.security.code.source.publisher.changed',
  'source.provenance.present': 'detail.plugin.security.code.source.provenance.present',
  'source.provenance.lost': 'detail.plugin.security.code.source.provenance.lost',
  'source.no-repository': 'detail.plugin.security.code.source.no-repository',
  'source.unavailable': 'detail.plugin.security.code.source.unavailable',
  'source.github.pinned': 'detail.plugin.security.code.source.github.pinned',
  'source.github.unpinned': 'detail.plugin.security.code.source.github.unpinned',
  'source.local': 'detail.plugin.security.code.source.local',
  'source.deprecated': 'detail.plugin.security.code.source.deprecated',
  'integrity.ok': 'detail.plugin.security.code.integrity.ok',
  'integrity.github': 'detail.plugin.security.code.integrity.github',
  'integrity.local': 'detail.plugin.security.code.integrity.local',
  'integrity.mismatch': 'detail.plugin.security.code.integrity.mismatch',
  'integrity.manifest-mismatch': 'detail.plugin.security.code.integrity.manifest-mismatch',
  'integrity.unavailable': 'detail.plugin.security.code.integrity.unavailable',
  'tarball.unsafe-path': 'detail.plugin.security.code.tarball.unsafe-path',
  'tarball.manifest-missing': 'detail.plugin.security.code.tarball.manifest-missing',
  'reputation.established': 'detail.plugin.security.code.reputation.established',
  'reputation.new': 'detail.plugin.security.code.reputation.new',
  'reputation.low-downloads': 'detail.plugin.security.code.reputation.low-downloads',
  'reputation.unknown': 'detail.plugin.security.code.reputation.unknown',
  'reputation.partial': 'detail.plugin.security.code.reputation.partial',
  'name.ok': 'detail.plugin.security.code.name.ok',
  'name.official-impersonation': 'detail.plugin.security.code.name.official-impersonation',
  'name.similar-installed': 'detail.plugin.security.code.name.similar-installed',
  'name.scope-similar': 'detail.plugin.security.code.name.scope-similar',
  'name.skipped': 'detail.plugin.security.code.name.skipped',
  'scripts.none': 'detail.plugin.security.code.scripts.none',
  'scripts.present': 'detail.plugin.security.code.scripts.present',
  'scripts.remote-fetch': 'detail.plugin.security.code.scripts.remote-fetch',
  'scripts.skipped': 'detail.plugin.security.code.scripts.skipped',
  'content.clean': 'detail.plugin.security.code.content.clean',
  'content.capabilities': 'detail.plugin.security.code.content.capabilities',
  'content.credential-exfil': 'detail.plugin.security.code.content.credential-exfil',
  'content.dynamic-eval': 'detail.plugin.security.code.content.dynamic-eval',
  'content.exfil-domain': 'detail.plugin.security.code.content.exfil-domain',
  'content.miner': 'detail.plugin.security.code.content.miner',
  'content.native-binary': 'detail.plugin.security.code.content.native-binary',
  'content.obfuscated-eval': 'detail.plugin.security.code.content.obfuscated-eval',
  'content.partial': 'detail.plugin.security.code.content.partial',
  'content.sensitive-read': 'detail.plugin.security.code.content.sensitive-read',
  'content.skipped': 'detail.plugin.security.code.content.skipped',
  'deps.registry-only': 'detail.plugin.security.code.deps.registry-only',
  'deps.non-registry': 'detail.plugin.security.code.deps.non-registry',
  'deps.native': 'detail.plugin.security.code.deps.native',
  'dependencies.skipped': 'detail.plugin.security.code.dependencies.skipped',
  'vuln.none': 'detail.plugin.security.code.vuln.none',
  'vuln.known': 'detail.plugin.security.code.vuln.known',
  'vuln.malware': 'detail.plugin.security.code.vuln.malware',
  'vuln.unavailable': 'detail.plugin.security.code.vuln.unavailable',
  'vuln.skipped': 'detail.plugin.security.code.vuln.skipped'
}

export function securityLevelText(t: Translator, level: PluginSecurityLevel): string {
  return t(LEVEL_KEYS[level])
}

export function securityCheckText(t: Translator, id: PluginSecurityCheck['id']): string {
  return t(CHECK_KEYS[id])
}

const SUMMARY_KEYS: Record<PluginSecurityVerdict, MessageKey> = {
  pass: 'detail.plugin.security.summary.pass',
  warn: 'detail.plugin.security.summary.warn',
  blocked: 'detail.plugin.security.summary.blocked',
  unavailable: 'detail.plugin.security.summary.unavailable',
  disabled: 'detail.plugin.security.summary.disabled'
}

export function securitySummaryText(t: Translator, verdict: PluginSecurityVerdict): string {
  return t(SUMMARY_KEYS[verdict])
}

export function securityVerdictText(
  t: Translator,
  verdict: PluginSecurityVerdict,
  params?: { count: number }
): string {
  if (verdict === 'warn') {
    return t(VERDICT_KEYS.warn, { count: params?.count ?? 0 })
  }
  return t(VERDICT_KEYS[verdict])
}

/** 检查/发现项的稳定 code 取文案；未知 code 原样返回，便于发现漏配。 */
export function securityCodeText(
  t: Translator,
  code: string,
  params?: Record<string, string | number | boolean | null>
): string {
  const key = CODE_KEYS[code]
  if (key === undefined) return code
  const values: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(params ?? {})) {
    if (value !== null) values[name] = typeof value === 'boolean' ? String(value) : value
  }
  return t(key, values)
}

/** warn / unavailable / 取数失败都需要显式确认后才能提交安装。 */
export function securityNeedsAcknowledgement(
  report: { verdict: PluginSecurityVerdict } | null,
  error: boolean
): boolean {
  if (error) return true
  if (report === null) return false
  return report.verdict === 'warn' || report.verdict === 'unavailable'
}

/** 阻止安装：danger/blocked 的硬闸门，以及检查结果明确不允许安装。 */
export function securityBlocked(report: { verdict: PluginSecurityVerdict } | null): boolean {
  return report?.verdict === 'blocked'
}
