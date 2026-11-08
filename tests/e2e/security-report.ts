import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginSecurityCheck, PluginSecurityReport } from '@shared/contracts'

const CHECK_IDS = [
  'source',
  'integrity',
  'reputation',
  'name',
  'scripts',
  'content',
  'dependencies',
  'vulnerabilities'
] as const

const PASS_CODES: Record<(typeof CHECK_IDS)[number], string> = {
  source: 'source.npm',
  integrity: 'integrity.ok',
  reputation: 'reputation.established',
  name: 'name.ok',
  scripts: 'scripts.none',
  content: 'content.capabilities',
  dependencies: 'deps.registry-only',
  vulnerabilities: 'vuln.none'
}

function passChecks(): PluginSecurityCheck[] {
  const contentParams = {
    spawn: 2,
    network: 5,
    fs: 3,
    env: 1,
    eval: 0,
    sensitive: 1,
    files: 12,
    minified: 0
  }
  return CHECK_IDS.map((id): PluginSecurityCheck => {
    let params: Record<string, string | number | boolean | null> = {}
    if (id === 'content') params = contentParams
    if (id === 'scripts') params = { count: 0 }
    if (id === 'integrity') params = { integrity: 'sha512-demo', files: 12, bytes: 24576 }
    return {
      id,
      level: 'pass',
      code: PASS_CODES[id],
      params,
      findingCodes: []
    }
  })
}

/** 一份可渲染的基线报告；E2E 用它跳过真实网络取数。 */
export function securityReport(patch: Partial<PluginSecurityReport> = {}): PluginSecurityReport {
  return {
    spec: 'demo-plugin@1.1.0',
    verdict: 'pass',
    checkedAt: '2026-11-08T03:00:00.000Z',
    durationMs: 120,
    fingerprint: 'sha512-demo',
    essentialComplete: true,
    partial: false,
    checks: passChecks(),
    findings: [],
    facts: {
      source: 'npm',
      registry: 'npmmirror',
      publisher: 'demo-author',
      maintainers: ['demo-author'],
      publishedAt: '2026-09-28T11:16:59.586Z',
      firstPublishedAt: '2025-01-01T00:00:00.000Z',
      versionCount: 4,
      downloads30d: 12345,
      repositoryUrl: 'https://github.com/demo/demo-plugin',
      deprecated: null,
      hasProvenance: true,
      hasRegistrySignature: false,
      unpackedSize: 24576,
      fileCount: 12,
      directDependencies: 1,
      nonRegistryDependencies: [],
      nativeModules: [],
      installScripts: []
    },
    ...patch
  }
}

/**
 * 写入固定检查报告并返回启动环境变量。
 * `name` 区分同一 spec 的不同报告文件，避免并行用例互相覆盖。
 */
export function securityReportEnv(
  dataDir: string,
  patch: Partial<PluginSecurityReport> = {},
  name = 'security-report'
): Record<string, string> {
  const path = join(dataDir, `${name}.json`)
  writeFileSync(path, JSON.stringify(securityReport(patch)), 'utf8')
  return { DSH_HUB_E2E_SECURITY_REPORT: path }
}
