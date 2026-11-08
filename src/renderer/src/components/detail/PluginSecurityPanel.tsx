import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PluginSecurityEvidence, PluginSecurityLevel } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import {
  securityCheckText,
  securityCodeText,
  securityLevelText,
  securitySummaryText,
  securityVerdictText
} from '../../lib/plugin-security-copy'
import type { PluginSecurityState } from '../../lib/use-plugin-security-check'
import { registryLabel } from './registry-choices'
import SectionHead from './SectionHead'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function evidenceText(evidence: PluginSecurityEvidence): string {
  const location =
    evidence.file === null
      ? null
      : evidence.line === null
        ? evidence.file
        : `${evidence.file}:${evidence.line}`
  return [location, evidence.match].filter((part) => part !== null && part !== '').join(' · ')
}

function checkLevelClass(level: PluginSecurityLevel): string {
  return `security-level security-level--${level}`
}

/**
 * 安装/升级确认区的安全检查面板。
 *
 * 展示判定、关键事实与可展开的逐项检查；所有检查都由主进程在解析版本后完成，
 * 本组件只负责取数状态与文案，不判断风险等级。
 */
export default function PluginSecurityPanel(props: {
  t: Translator
  state: PluginSecurityState
  onRefresh: () => void
  /** 展开检查内容时通知外层（升级确认框据此收起安装源，把空间让给逐项结果）。 */
  onExpand?: () => void
}): ReactNode {
  const { t, state, onRefresh, onExpand } = props
  const [open, setOpen] = useState(true)
  const report = state.status === 'ready' ? state.report : null
  const warnCount = report?.checks.filter((check) => check.level === 'warn').length ?? 0
  const blocked = report?.verdict === 'blocked'
  const noteClass =
    report?.verdict === 'pass'
      ? 'n-ok'
      : report?.verdict === 'warn' || report?.verdict === 'unavailable'
        ? 'n-warn'
        : blocked
          ? 'n-danger'
          : 'n-info'

  /** 折叠后仍要能判断状态：判定徽标留在标题行。 */
  const header = (
    <SectionHead
      className="mt16"
      title={t('detail.plugin.security.title')}
      aside={
        state.status === 'disabled' ? (
          <span className="badge">{t('detail.plugin.security.verdict.disabled')}</span>
        ) : report !== null ? (
          <span className={`badge security-badge security-badge--${report.verdict}`}>
            {securityVerdictText(t, report.verdict, { count: warnCount })}
          </span>
        ) : null
      }
      open={open}
      onToggle={() => {
        const next = !open
        setOpen(next)
        if (next) onExpand?.()
      }}
      actions={
        state.status !== 'disabled' && state.status !== 'idle' ? (
          <button
            className="btn btn-secondary btn-sm"
            onClick={onRefresh}
            disabled={state.status === 'loading'}
            data-testid="plugin-security-refresh"
          >
            <Icon name="refresh" />{' '}
            {state.status === 'loading'
              ? t('detail.plugin.security.refreshing')
              : t('detail.plugin.security.refresh')}
          </button>
        ) : null
      }
      testId="plugin-security-toggle"
    />
  )

  if (state.status === 'disabled') {
    return (
      <div data-testid="plugin-security-panel" data-verdict="disabled">
        {header}
        {open && (
          <div className="note n-info">
            <Icon name="info" />
            <span>
              {t('detail.plugin.security.summary.disabled')}{' '}
              {t('detail.plugin.security.disabledHint')}
            </span>
          </div>
        )}
      </div>
    )
  }

  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div data-testid="plugin-security-panel" data-verdict="checking">
        {header}
        {open && (
          <p className="meta" data-testid="plugin-security-loading">
            {t('detail.plugin.security.checking')}
          </p>
        )}
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div data-testid="plugin-security-panel" data-verdict="error">
        {header}
        {open && (
          <>
            <p className="meta err-text" data-testid="plugin-security-error">
              {t('detail.plugin.security.checkFailed', { msg: state.message })}
            </p>
            <div className="note n-warn mt12">
              <Icon name="alert" />
              <span>{t('detail.plugin.security.summary.unavailable')}</span>
            </div>
          </>
        )}
      </div>
    )
  }

  const readyReport = state.report
  const { facts } = readyReport
  const sourceLabel =
    facts.source === 'npm'
      ? `${t('detail.plugin.confirmSourceNpm')}${
          facts.registry === null ? '' : ` · ${registryLabel(t, facts.registry)}`
        }`
      : facts.source === 'github'
        ? t('detail.plugin.confirmSourceGithub')
        : t('detail.plugin.confirmSourceFile')
  const sourceCheck = readyReport.checks.find((check) => check.id === 'source')
  const githubRepo =
    sourceCheck !== undefined &&
    typeof sourceCheck.params.owner === 'string' &&
    typeof sourceCheck.params.repo === 'string'
      ? `${sourceCheck.params.owner}/${sourceCheck.params.repo}`
      : null
  const publisherParts = [
    sourceLabel,
    githubRepo,
    facts.publisher === null
      ? null
      : t('detail.plugin.security.facts.publisher', { name: facts.publisher }),
    facts.versionCount === null
      ? null
      : t('detail.plugin.security.facts.versions', { count: facts.versionCount }),
    facts.downloads30d === null
      ? null
      : t('detail.plugin.security.facts.downloads', { count: facts.downloads30d })
  ].filter((part): part is string => part !== null)

  const integrity = readyReport.checks.find((check) => check.id === 'integrity')
  const integrityParts = [
    integrity === undefined ? null : securityCodeText(t, integrity.code, integrity.params),
    facts.unpackedSize === null || facts.fileCount === null
      ? null
      : t('detail.plugin.security.facts.size', {
          size: formatBytes(facts.unpackedSize),
          files: facts.fileCount
        })
  ].filter((part): part is string => part !== null)

  const scriptNames = facts.installScripts.map((script) => script.name).join(', ')
  const scripts = readyReport.checks.find((check) => check.id === 'scripts')
  const content = readyReport.checks.find((check) => check.id === 'content')
  const dependencies = readyReport.checks.find((check) => check.id === 'dependencies')
  const vulnerabilities = readyReport.checks.find((check) => check.id === 'vulnerabilities')

  const dependencyParts = [
    t('detail.plugin.security.facts.deps', { count: facts.directDependencies }),
    facts.nonRegistryDependencies.length > 0
      ? t('detail.plugin.security.facts.nonRegistry', {
          count: facts.nonRegistryDependencies.length
        })
      : null,
    facts.nativeModules.length > 0
      ? t('detail.plugin.security.facts.native', { count: facts.nativeModules.length })
      : null
  ].filter((part): part is string => part !== null)

  return (
    <div data-testid="plugin-security-panel" data-verdict={readyReport.verdict}>
      {header}
      {open && (
        <>
          <div className={`note ${noteClass}`} data-testid="plugin-security-summary">
            <Icon name={readyReport.verdict === 'pass' ? 'check' : 'alert'} />
            <span>{securitySummaryText(t, readyReport.verdict)}</span>
          </div>

          <dl className="kv mt12">
            <dt>{t('detail.plugin.security.fact.source')}</dt>
            <dd data-testid="plugin-security-source">{publisherParts.join(' · ')}</dd>
            <dt>{t('detail.plugin.security.fact.integrity')}</dt>
            <dd data-testid="plugin-security-integrity">
              {integrityParts.length > 0
                ? integrityParts.join(' · ')
                : t('detail.plugin.security.facts.none')}
            </dd>
            <dt>{t('detail.plugin.security.fact.scripts')}</dt>
            <dd data-testid="plugin-security-scripts">
              {scripts === undefined ? (
                t('detail.plugin.security.facts.none')
              ) : (
                <>
                  {scriptNames === ''
                    ? securityCodeText(t, scripts.code, scripts.params)
                    : t('detail.plugin.security.facts.scripts', { names: scriptNames })}
                  <span className="meta" style={{ display: 'block', marginTop: 3 }}>
                    {t('detail.plugin.security.pnpmNote')}
                  </span>
                </>
              )}
            </dd>
            <dt>{t('detail.plugin.security.fact.content')}</dt>
            <dd data-testid="plugin-security-content">
              {content === undefined
                ? t('detail.plugin.security.facts.none')
                : securityCodeText(t, content.code, content.params)}
            </dd>
            <dt>{t('detail.plugin.security.fact.dependencies')}</dt>
            <dd data-testid="plugin-security-dependencies">
              {dependencyParts.join(' · ')}
              {dependencies === undefined || dependencies.level === 'pass' ? null : (
                <span className="meta" style={{ display: 'block', marginTop: 3 }}>
                  {securityCodeText(t, dependencies.code, dependencies.params)}
                </span>
              )}
            </dd>
            <dt>{t('detail.plugin.security.fact.vulnerabilities')}</dt>
            <dd data-testid="plugin-security-vulnerabilities">
              {vulnerabilities === undefined
                ? t('detail.plugin.security.facts.none')
                : securityCodeText(t, vulnerabilities.code, vulnerabilities.params)}
            </dd>
          </dl>

          {readyReport.partial && (
            <p className="meta mt8" data-testid="plugin-security-partial">
              {t('detail.plugin.security.partial')}
            </p>
          )}

          <details
            className="adv mt12 security-details"
            data-testid="plugin-security-details"
            onToggle={(event) => {
              if (event.currentTarget.open) onExpand?.()
            }}
          >
            <summary>{t('detail.plugin.security.details')}</summary>
            <div className="security-checks">
              {readyReport.checks.map((check) => (
                <div className="security-check" key={check.id}>
                  <span className="security-check-name">{securityCheckText(t, check.id)}</span>
                  <span className={checkLevelClass(check.level)}>
                    {securityLevelText(t, check.level)}
                  </span>
                  <span className="security-check-code">
                    {securityCodeText(t, check.code, check.params)}
                  </span>
                </div>
              ))}
            </div>
            {readyReport.findings.length > 0 && (
              <div className="security-findings">
                {readyReport.findings.map((finding) => (
                  <div className="security-finding" key={finding.code}>
                    <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
                      <span className={`security-dot security-dot--${finding.level}`} />
                      <span>{securityCodeText(t, finding.code)}</span>
                      {finding.count > 1 && <span className="meta">×{finding.count}</span>}
                      {finding.refs.length > 0 && (
                        <span className="meta num">{finding.refs.join(', ')}</span>
                      )}
                    </div>
                    {finding.evidence.length > 0 && (
                      <ul className="security-evidence">
                        {finding.evidence.map((evidence, index) => (
                          <li key={`${finding.code}-${index}`} className="meta num">
                            {evidenceText(evidence)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </details>

          <p className="meta mt8">{t('detail.plugin.security.privacy')}</p>
        </>
      )}
    </div>
  )
}
