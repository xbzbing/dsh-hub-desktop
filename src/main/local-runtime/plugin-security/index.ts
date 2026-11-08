/**
 * 插件安装安全检查器：编排 manifest/tarball 取数、完整性校验、静态扫描与判定。
 *
 * 只读、不执行、不上传源码。网络失败与超限降级为 `unavailable`/`partial`，
 * 只有完整性/身份/路径/恶意包等硬失败或 danger 规则才返回 `blocked`。
 */
import { promises as fs } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type {
  PluginRegistryOption,
  PluginSecurityCheck,
  PluginSecurityFacts,
  PluginSecurityFinding,
  PluginSecurityReport
} from '@shared/contracts'
import { InstanceStoreError } from '../../registry/instance-store'
import { classifyPluginSpec, splitNpmSpec } from '../plugin-spec'
import { SECURITY_LIMITS } from './limits'
import { defaultSecurityFetcher, type SecurityFetcher } from './net'
import {
  allowedCodeloadUrl,
  allowedTarballUrl,
  fetchDownloads,
  fetchPackument,
  fetchVersionManifest,
  queryOsv,
  type NpmPackumentInfo,
  type NpmVersionManifest,
  type OsvVulnerability,
  parseVersionManifest
} from './registry'
import { dependencyFacts, scanContent, scanScripts } from './scan'
import { packageJsonEntry, readTarEntries, type TarEntry } from './tar'
import { checkPluginName } from './typosquat'
import { buildReport, checkOf } from './verdict'

export interface SecurityInstalledPlugin {
  name: string
  version: string
}

export interface SecurityCheckInput {
  spec: string
  registry: PluginRegistryOption
  installed: readonly SecurityInstalledPlugin[]
  refresh?: boolean
}

export interface PluginSecurityChecker {
  check(input: SecurityCheckInput): Promise<PluginSecurityReport>
}

export interface PluginSecurityCheckerDeps {
  fetcher?: SecurityFetcher
  now?: () => number
  /** 单次检查的总预算；缺省用 SECURITY_LIMITS.totalTimeoutMs（测试可缩短）。 */
  totalTimeoutMs?: number
}

const REPORT_TTL_MS = 10 * 60_000
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

interface FactsInput {
  source: 'npm' | 'github' | 'file'
  registry: PluginRegistryOption | null
  manifest?: NpmVersionManifest | null
  packument?: NpmPackumentInfo | null
  downloads?: number | null
  entries?: readonly TarEntry[]
  scripts?: Array<{ name: string; command: string }>
  nativeModules?: string[]
  unpackedSize?: number | null
  fileCount?: number | null
}

function emptyFacts(source: 'npm' | 'github' | 'file'): PluginSecurityFacts {
  return {
    source,
    registry: null,
    publisher: null,
    maintainers: [],
    publishedAt: null,
    firstPublishedAt: null,
    versionCount: null,
    downloads30d: null,
    repositoryUrl: null,
    deprecated: null,
    hasProvenance: false,
    hasRegistrySignature: false,
    unpackedSize: null,
    fileCount: null,
    directDependencies: 0,
    nonRegistryDependencies: [],
    nativeModules: [],
    installScripts: []
  }
}

function factsOf(input: FactsInput): PluginSecurityFacts {
  const facts = emptyFacts(input.source)
  const manifest = input.manifest ?? null
  const packument = input.packument ?? null
  const deps =
    manifest === null
      ? { directDependencies: 0, nonRegistryDependencies: [] }
      : dependencyFacts(manifest)
  return {
    ...facts,
    registry: input.registry,
    publisher: manifest?.publisher ?? null,
    maintainers: manifest?.maintainers.length
      ? manifest.maintainers
      : (packument?.maintainers ?? []),
    publishedAt:
      manifest === null ? null : (packument?.versionPublishedAt[manifest.version] ?? null),
    firstPublishedAt: packument?.firstPublishedAt ?? null,
    versionCount: packument?.versionCount ?? null,
    downloads30d: input.downloads ?? null,
    repositoryUrl: manifest?.repositoryUrl ?? null,
    deprecated: manifest?.deprecated ?? null,
    hasProvenance: manifest?.dist.hasProvenance ?? false,
    hasRegistrySignature: manifest?.dist.hasSignatures ?? false,
    unpackedSize: input.unpackedSize ?? manifest?.dist.unpackedSize ?? null,
    fileCount: input.fileCount ?? manifest?.dist.fileCount ?? null,
    directDependencies: deps.directDependencies,
    nonRegistryDependencies: deps.nonRegistryDependencies,
    nativeModules: input.nativeModules ?? [],
    installScripts: input.scripts ?? []
  }
}

function finding(
  code: string,
  level: 'info' | 'warn' | 'danger',
  match: string | null,
  refs: string[] = []
): PluginSecurityFinding {
  return {
    code,
    level,
    count: 1,
    evidence: [{ file: null, line: null, match }],
    refs
  }
}

function skippedCheck(id: PluginSecurityCheck['id'], code: string): PluginSecurityCheck {
  return checkOf(id, 'skip', code)
}

function unavailableReport(
  spec: string,
  started: number,
  now: () => number,
  source: 'npm' | 'github' | 'file' = 'npm'
): PluginSecurityReport {
  const checks: PluginSecurityCheck[] = [
    skippedCheck('source', 'source.unavailable'),
    skippedCheck('integrity', 'integrity.unavailable'),
    skippedCheck('reputation', 'reputation.partial'),
    skippedCheck('name', 'name.skipped'),
    skippedCheck('scripts', 'scripts.skipped'),
    skippedCheck('content', 'content.skipped'),
    skippedCheck('dependencies', 'dependencies.skipped'),
    skippedCheck('vulnerabilities', 'vuln.skipped')
  ]
  return buildReport({
    spec,
    checks,
    findings: [],
    facts: emptyFacts(source),
    fingerprint: null,
    essentialComplete: false,
    partial: false,
    durationMs: Math.max(0, now() - started),
    checkedAt: new Date(now()).toISOString()
  })
}

const CHECK_ORDER: PluginSecurityCheck['id'][] = [
  'source',
  'integrity',
  'reputation',
  'name',
  'scripts',
  'content',
  'dependencies',
  'vulnerabilities'
]

const SKIPPED_CODES: Record<PluginSecurityCheck['id'], string> = {
  source: 'source.unavailable',
  integrity: 'integrity.unavailable',
  reputation: 'reputation.partial',
  name: 'name.skipped',
  scripts: 'scripts.skipped',
  content: 'content.skipped',
  dependencies: 'dependencies.skipped',
  vulnerabilities: 'vuln.skipped'
}

function blockedReport(
  spec: string,
  started: number,
  now: () => number,
  code: string,
  findingCode: string,
  facts: PluginSecurityFacts,
  extraChecks: PluginSecurityCheck[] = []
): PluginSecurityReport {
  // 硬阻止也要给出完整检查清单：已完成的沿用，未执行的标为 skip，
  // 面板上不会出现「只有两行、其余检查凭空消失」。
  const byId = new Map(extraChecks.map((check) => [check.id, check]))
  byId.set('integrity', checkOf('integrity', 'blocked', code))
  byId.set('content', skippedCheck('content', 'content.skipped'))
  const checks = CHECK_ORDER.map((id) => byId.get(id) ?? skippedCheck(id, SKIPPED_CODES[id]))
  return buildReport({
    spec,
    checks,
    findings: [finding(findingCode, 'danger', code)],
    facts,
    fingerprint: null,
    essentialComplete: true,
    partial: false,
    durationMs: Math.max(0, now() - started),
    checkedAt: new Date(now()).toISOString()
  })
}

function hashOf(bytes: Buffer): { integrity: string; sha1: string; sha1Base64: string } {
  const sha1 = createHash('sha1').update(bytes).digest()
  return {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha1: sha1.toString('hex'),
    sha1Base64: `sha1-${sha1.toString('base64')}`
  }
}

interface UnpackedTarball {
  entries: TarEntry[]
  unpackedSize: number
  fileCount: number
}

function unpackTarball(bytes: Buffer): UnpackedTarball {
  let unpacked: Buffer
  try {
    unpacked = gunzipSync(bytes, { maxOutputLength: SECURITY_LIMITS.maxUnpackedBytes })
  } catch {
    throw new Error('包体解压失败')
  }
  const entries = readTarEntries(unpacked, {
    maxEntries: SECURITY_LIMITS.maxEntries,
    maxFileBytes: SECURITY_LIMITS.maxFileScanBytes,
    maxUnpackedBytes: SECURITY_LIMITS.maxUnpackedBytes
  })
  return {
    entries,
    unpackedSize: entries.reduce((total, entry) => total + entry.size, 0),
    fileCount: entries.filter((entry) => entry.type === 'file').length
  }
}

function manifestFromEntry(entry: TarEntry): NpmVersionManifest | null {
  if (entry.data === null) return null
  try {
    return parseVersionManifest(JSON.parse(entry.data.toString('utf8')) as unknown)
  } catch {
    return null
  }
}

function sourceCheck(
  registry: PluginRegistryOption,
  manifest: NpmVersionManifest,
  installedManifest: NpmVersionManifest | null
): { check: PluginSecurityCheck; findings: PluginSecurityFinding[]; partial: boolean } {
  const findings: PluginSecurityFinding[] = []
  if (manifest.deprecated !== null) {
    findings.push(finding('source.deprecated', 'warn', manifest.deprecated))
  }
  if (installedManifest !== null) {
    if (
      installedManifest.publisher !== null &&
      manifest.publisher !== null &&
      installedManifest.publisher !== manifest.publisher
    ) {
      findings.push(
        finding(
          'source.publisher.changed',
          'warn',
          `${installedManifest.publisher} → ${manifest.publisher}`
        )
      )
    }
    if (installedManifest.dist.hasProvenance && !manifest.dist.hasProvenance) {
      findings.push(finding('source.provenance.lost', 'warn', 'provenance'))
    }
  }
  if (manifest.dist.hasProvenance) {
    findings.push(finding('source.provenance.present', 'info', 'provenance'))
  }
  if (registry === 'npmmirror') {
    findings.push(finding('source.mirror', 'info', 'npmmirror'))
  }
  if (manifest.repositoryUrl === null) {
    findings.push(finding('source.no-repository', 'info', 'repository'))
  }
  const warn = findings.find((item) => item.level === 'warn')
  return {
    check: checkOf(
      'source',
      warn === undefined ? 'pass' : 'warn',
      warn?.code ?? 'source.npm',
      { registry, publisher: manifest.publisher, deprecated: manifest.deprecated },
      findings
    ),
    findings,
    partial: false
  }
}

function reputationCheck(
  packument: NpmPackumentInfo | null,
  manifest: NpmVersionManifest,
  downloads: number | null,
  nowMs: number
): { check: PluginSecurityCheck; findings: PluginSecurityFinding[]; partial: boolean } {
  if (packument === null || packument.firstPublishedAt === null) {
    return {
      check: skippedCheck('reputation', 'reputation.partial'),
      findings: [],
      partial: true
    }
  }
  const first = Date.parse(packument.firstPublishedAt)
  const ageDays = Number.isFinite(first) ? (nowMs - first) / 86_400_000 : null
  const findings: PluginSecurityFinding[] = []
  if (ageDays !== null && ageDays < 30) {
    findings.push(finding('reputation.new', 'info', packument.firstPublishedAt))
  }
  if (downloads !== null && downloads < 1000) {
    findings.push(finding('reputation.low-downloads', 'info', String(downloads)))
  }
  if (
    ageDays !== null &&
    ageDays < 30 &&
    downloads !== null &&
    downloads < 1000 &&
    manifest.repositoryUrl === null &&
    !manifest.dist.hasProvenance
  ) {
    findings.push(finding('reputation.unknown', 'warn', 'new+low+no-repo+no-provenance'))
    return {
      check: checkOf(
        'reputation',
        'warn',
        'reputation.unknown',
        { downloads, ageDays, versionCount: packument.versionCount },
        findings
      ),
      findings,
      partial: false
    }
  }
  const code =
    ageDays !== null && ageDays < 30
      ? 'reputation.new'
      : downloads !== null && downloads < 1000
        ? 'reputation.low-downloads'
        : 'reputation.established'
  return {
    check: checkOf(
      'reputation',
      'pass',
      code,
      { downloads, ageDays, versionCount: packument.versionCount },
      findings
    ),
    findings,
    partial: false
  }
}

function vulnerabilityCheck(vulns: OsvVulnerability[] | null): {
  check: PluginSecurityCheck
  findings: PluginSecurityFinding[]
  partial: boolean
} {
  if (vulns === null) {
    return {
      check: skippedCheck('vulnerabilities', 'vuln.unavailable'),
      findings: [],
      partial: true
    }
  }
  const malware = vulns.filter((item) => item.id.startsWith('MAL-'))
  if (malware.length > 0) {
    const findings = malware.map((item) => finding('vuln.malware', 'danger', item.id, [item.id]))
    return {
      check: checkOf(
        'vulnerabilities',
        'blocked',
        'vuln.malware',
        { count: malware.length },
        findings
      ),
      findings,
      partial: false
    }
  }
  if (vulns.length > 0) {
    const findings = vulns.map((item) => finding('vuln.known', 'warn', item.id, [item.id]))
    return {
      check: checkOf('vulnerabilities', 'warn', 'vuln.known', { count: vulns.length }, findings),
      findings,
      partial: false
    }
  }
  return {
    check: checkOf('vulnerabilities', 'pass', 'vuln.none'),
    findings: [],
    partial: false
  }
}

function contentCheck(entries: readonly TarEntry[]): {
  check: PluginSecurityCheck
  findings: PluginSecurityFinding[]
  partial: boolean
  nativeModules: string[]
} {
  const scan = scanContent(entries)
  const danger = scan.findings.find((item) => item.level === 'danger')
  const warn = scan.findings.find((item) => item.level === 'warn')
  const level = danger !== undefined ? 'danger' : warn !== undefined ? 'warn' : 'pass'
  const code =
    danger?.code ?? warn?.code ?? (scan.scannedFiles > 0 ? 'content.capabilities' : 'content.clean')
  return {
    check: checkOf(
      'content',
      level,
      code,
      {
        spawn: scan.capabilities.spawn,
        network: scan.capabilities.network,
        fs: scan.capabilities.fs,
        env: scan.capabilities.env,
        eval: scan.capabilities.eval,
        sensitive: scan.capabilities.sensitive,
        files: scan.scannedFiles,
        minified: scan.minifiedFiles
      },
      scan.findings
    ),
    findings: scan.findings,
    partial: scan.partial,
    nativeModules: scan.nativeModules
  }
}

function dependenciesCheck(
  manifest: NpmVersionManifest,
  nativeModules: readonly string[]
): { check: PluginSecurityCheck; findings: PluginSecurityFinding[] } {
  const deps = dependencyFacts(manifest)
  const findings: PluginSecurityFinding[] = []
  if (deps.nonRegistryDependencies.length > 0) {
    findings.push(
      ...deps.nonRegistryDependencies.map((name) => finding('deps.non-registry', 'warn', name))
    )
  }
  if (nativeModules.length > 0) {
    findings.push(...nativeModules.slice(0, 5).map((name) => finding('deps.native', 'warn', name)))
  }
  const warn = findings.find((item) => item.level === 'warn')
  return {
    check: checkOf(
      'dependencies',
      warn === undefined ? 'pass' : 'warn',
      warn?.code ?? 'deps.registry-only',
      {
        count: deps.directDependencies,
        nonRegistry: deps.nonRegistryDependencies.length,
        native: nativeModules.length
      },
      findings
    ),
    findings
  }
}

function integrityCheck(
  manifest: NpmVersionManifest,
  tarball: { integrity: string; sha1: string; sha1Base64: string },
  unpacked: UnpackedTarball
): { check: PluginSecurityCheck; blockedCode: string | null } {
  const expected = manifest.dist.integrity
  const expectedSha1 = manifest.dist.shasum
  const mismatch = (): { check: PluginSecurityCheck; blockedCode: string } => ({
    check: checkOf('integrity', 'blocked', 'integrity.mismatch'),
    blockedCode: 'integrity.mismatch'
  })
  if (expected !== null) {
    if (expected.startsWith('sha512-') && expected !== tarball.integrity) return mismatch()
    if (expected.startsWith('sha1-') && expected !== tarball.sha1Base64) return mismatch()
  }
  if (expectedSha1 !== null && expectedSha1 !== tarball.sha1) return mismatch()
  if (expected === null && expectedSha1 === null) {
    return {
      check: skippedCheck('integrity', 'integrity.unavailable'),
      blockedCode: null
    }
  }
  return {
    check: checkOf('integrity', 'pass', 'integrity.ok', {
      integrity: tarball.integrity,
      files: unpacked.fileCount,
      bytes: unpacked.unpackedSize
    }),
    blockedCode: null
  }
}

function mergeChecks(checks: readonly PluginSecurityCheck[]): PluginSecurityCheck[] {
  return [...checks]
}

async function checkNpm(
  input: SecurityCheckInput,
  deps: Required<Pick<PluginSecurityCheckerDeps, 'fetcher' | 'now'>>,
  started: number
): Promise<PluginSecurityReport> {
  const { name, requested } = splitNpmSpec(input.spec)
  if (requested === null || !EXACT_VERSION.test(requested)) {
    throw new InstanceStoreError('invalid-input', `安全检查需要精确版本：${name}@x.y.z`)
  }
  const nowMs = deps.now()
  const manifest = await fetchVersionManifest(deps.fetcher, input.registry, name, requested)
  const [packument, downloads, vulns, installedVersion] = await Promise.all([
    fetchPackument(deps.fetcher, input.registry, name),
    fetchDownloads(deps.fetcher, name),
    queryOsv(deps.fetcher, name, requested),
    Promise.resolve(
      input.installed.find((item) => item.name.toLowerCase() === name.toLowerCase())?.version ??
        null
    )
  ])

  let installedManifest: NpmVersionManifest | null = null
  let installedManifestFailed = false
  if (installedVersion !== null && installedVersion !== requested) {
    try {
      installedManifest = await fetchVersionManifest(
        deps.fetcher,
        input.registry,
        name,
        installedVersion
      )
    } catch {
      installedManifestFailed = true
    }
  }

  const tarballUrl = allowedTarballUrl(manifest.dist.tarball, input.registry)
  if (tarballUrl === null) {
    return unavailableReport(input.spec, started, deps.now, 'npm')
  }

  let bytes: Buffer
  try {
    bytes = await deps.fetcher.fetchBytes(tarballUrl, {
      timeoutMs: SECURITY_LIMITS.requestTimeoutMs,
      maxBytes: SECURITY_LIMITS.maxTarballBytes
    })
  } catch {
    return unavailableReport(input.spec, started, deps.now, 'npm')
  }

  let unpacked: UnpackedTarball
  try {
    unpacked = unpackTarball(bytes)
  } catch {
    return unavailableReport(input.spec, started, deps.now, 'npm')
  }

  const pkgEntry = packageJsonEntry(unpacked.entries)
  if (pkgEntry === null) {
    return blockedReport(
      input.spec,
      started,
      deps.now,
      'tarball.manifest-missing',
      'tarball.manifest-missing',
      factsOf({ source: 'npm', registry: input.registry, manifest })
    )
  }
  const tarballManifest = manifestFromEntry(pkgEntry)
  if (tarballManifest === null) {
    return blockedReport(
      input.spec,
      started,
      deps.now,
      'tarball.manifest-missing',
      'tarball.manifest-missing',
      factsOf({ source: 'npm', registry: input.registry, manifest })
    )
  }
  if (
    tarballManifest.name.toLowerCase() !== name.toLowerCase() ||
    tarballManifest.version !== requested
  ) {
    return blockedReport(
      input.spec,
      started,
      deps.now,
      'integrity.manifest-mismatch',
      'integrity.manifest-mismatch',
      factsOf({ source: 'npm', registry: input.registry, manifest })
    )
  }
  const unsafe = unpacked.entries.find((entry) => entry.unsafe)
  if (unsafe !== undefined) {
    return blockedReport(
      input.spec,
      started,
      deps.now,
      'tarball.unsafe-path',
      'tarball.unsafe-path',
      factsOf({
        source: 'npm',
        registry: input.registry,
        manifest,
        unpackedSize: unpacked.unpackedSize,
        fileCount: unpacked.fileCount
      }),
      [checkOf('source', 'pass', 'source.npm', { registry: input.registry })]
    )
  }

  const hashes = hashOf(bytes)
  const integrity = integrityCheck(manifest, hashes, unpacked)
  if (integrity.blockedCode !== null) {
    return blockedReport(
      input.spec,
      started,
      deps.now,
      integrity.blockedCode,
      integrity.blockedCode,
      factsOf({ source: 'npm', registry: input.registry, manifest })
    )
  }

  const source = sourceCheck(input.registry, manifest, installedManifest)
  const reputation = reputationCheck(packument, manifest, downloads, nowMs)
  const nameCheck = checkPluginName(
    name,
    input.installed.map((item) => item.name)
  )
  const scripts = scanScripts(tarballManifest, false)
  const content = contentCheck(unpacked.entries)
  const dependencies = dependenciesCheck(tarballManifest, content.nativeModules)
  const vulnerability = vulnerabilityCheck(vulns)
  const facts = factsOf({
    source: 'npm',
    registry: input.registry,
    manifest,
    packument,
    downloads,
    entries: unpacked.entries,
    scripts: scripts.installScripts,
    nativeModules: content.nativeModules,
    unpackedSize: unpacked.unpackedSize,
    fileCount: unpacked.fileCount
  })
  const checks: PluginSecurityCheck[] = [
    source.check,
    integrity.check,
    reputation.check,
    checkOf('name', nameCheck.level, nameCheck.code, nameCheck.params, nameCheck.findings),
    checkOf(
      'scripts',
      scripts.level,
      scripts.code,
      { count: scripts.installScripts.length },
      scripts.findings
    ),
    content.check,
    dependencies.check,
    vulnerability.check
  ]
  return buildReport({
    spec: input.spec,
    checks: mergeChecks(checks),
    findings: [
      ...source.findings,
      ...nameCheck.findings,
      ...scripts.findings,
      ...content.findings,
      ...dependencies.findings,
      ...vulnerability.findings
    ],
    facts,
    fingerprint: hashes.integrity,
    essentialComplete: integrity.check.level !== 'skip' && content.check.level !== 'skip',
    partial:
      reputation.partial || vulnerability.partial || content.partial || installedManifestFailed
        ? true
        : false,
    durationMs: Math.max(0, deps.now() - started),
    checkedAt: new Date(deps.now()).toISOString()
  })
}

function parseGithubSpec(spec: string): { owner: string; repo: string; ref: string } | null {
  let raw = spec
    .replace(/^github:/i, '')
    .replace(/^git\+https:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
  raw = raw.replace(/\.git(?=#|$)/i, '')
  const [pathPart, refPart = ''] = raw.split('#')
  const [owner, repo] = (pathPart ?? '').split('/')
  if (owner === undefined || repo === undefined || owner === '' || repo === '') return null
  return { owner, repo, ref: refPart }
}

async function checkGithub(
  input: SecurityCheckInput,
  deps: Required<Pick<PluginSecurityCheckerDeps, 'fetcher' | 'now'>>,
  started: number
): Promise<PluginSecurityReport> {
  // 只覆盖 GitHub；其他 git 主机（GitLab 等）当前没有静态检查能力，
  // 按「关键检查未完成」返回，交给用户在确认后决定是否安装。
  const githubSpec = /^(?:github:|git\+https:\/\/github\.com\/|git@github\.com:)/i.test(input.spec)
  const parsed = parseGithubSpec(input.spec)
  if (!githubSpec || parsed === null) {
    return unavailableReport(input.spec, started, deps.now, 'github')
  }
  const url = allowedCodeloadUrl(parsed.owner, parsed.repo, parsed.ref === '' ? 'HEAD' : parsed.ref)
  if (url === null) return unavailableReport(input.spec, started, deps.now, 'github')
  let bytes: Buffer
  try {
    bytes = await deps.fetcher.fetchBytes(url, {
      timeoutMs: SECURITY_LIMITS.requestTimeoutMs,
      maxBytes: SECURITY_LIMITS.maxTarballBytes
    })
  } catch {
    return unavailableReport(input.spec, started, deps.now, 'github')
  }
  let unpacked: UnpackedTarball
  try {
    unpacked = unpackTarball(bytes)
  } catch {
    return unavailableReport(input.spec, started, deps.now, 'github')
  }
  const pkgEntry = packageJsonEntry(unpacked.entries)
  if (pkgEntry === null) {
    return blockedReport(
      input.spec,
      started,
      deps.now,
      'tarball.manifest-missing',
      'tarball.manifest-missing',
      emptyFacts('github')
    )
  }
  const tarballManifest = manifestFromEntry(pkgEntry)
  if (tarballManifest === null) {
    return blockedReport(
      input.spec,
      started,
      deps.now,
      'tarball.manifest-missing',
      'tarball.manifest-missing',
      emptyFacts('github')
    )
  }
  const unsafe = unpacked.entries.find((entry) => entry.unsafe)
  if (unsafe !== undefined) {
    return blockedReport(
      input.spec,
      started,
      deps.now,
      'tarball.unsafe-path',
      'tarball.unsafe-path',
      emptyFacts('github')
    )
  }
  const scripts = scanScripts(tarballManifest, true)
  const content = contentCheck(unpacked.entries)
  const dependencies = dependenciesCheck(tarballManifest, content.nativeModules)
  const nameCheck = checkPluginName(
    tarballManifest.name,
    input.installed.map((item) => item.name)
  )
  const sourceFindings: PluginSecurityFinding[] = []
  if (parsed.ref === '') {
    sourceFindings.push(finding('source.github.unpinned', 'warn', `${parsed.owner}/${parsed.repo}`))
  }
  const fingerprint = /^[0-9a-f]{40}$/i.test(parsed.ref) ? parsed.ref : null
  const facts = factsOf({
    source: 'github',
    registry: null,
    manifest: tarballManifest,
    scripts: scripts.installScripts,
    nativeModules: content.nativeModules,
    unpackedSize: unpacked.unpackedSize,
    fileCount: unpacked.fileCount
  })
  const checks: PluginSecurityCheck[] = [
    checkOf(
      'source',
      parsed.ref === '' ? 'warn' : 'pass',
      parsed.ref === '' ? 'source.github.unpinned' : 'source.github.pinned',
      { owner: parsed.owner, repo: parsed.repo, ref: parsed.ref },
      sourceFindings
    ),
    checkOf('integrity', 'pass', 'integrity.github', {
      files: unpacked.fileCount,
      bytes: unpacked.unpackedSize
    }),
    skippedCheck('reputation', 'reputation.partial'),
    checkOf('name', nameCheck.level, nameCheck.code, nameCheck.params, nameCheck.findings),
    checkOf(
      'scripts',
      scripts.level,
      scripts.code,
      { count: scripts.installScripts.length },
      scripts.findings
    ),
    content.check,
    dependencies.check,
    skippedCheck('vulnerabilities', 'vuln.unavailable')
  ]
  return buildReport({
    spec: input.spec,
    checks,
    findings: [
      ...sourceFindings,
      ...nameCheck.findings,
      ...scripts.findings,
      ...content.findings,
      ...dependencies.findings
    ],
    facts,
    fingerprint,
    essentialComplete: true,
    partial: true,
    durationMs: Math.max(0, deps.now() - started),
    checkedAt: new Date(deps.now()).toISOString()
  })
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'coverage'])

async function readLocalEntries(root: string): Promise<UnpackedTarball> {
  const entries: TarEntry[] = []
  let total = 0
  let fileCount = 0

  async function walk(dir: string): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true })
    for (const item of items) {
      const full = join(dir, item.name)
      const rel = relative(root, full).replace(/\\/g, '/')
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name)) continue
        await walk(full)
        continue
      }
      if (!item.isFile()) continue
      const stat = await fs.stat(full)
      if (entries.length >= SECURITY_LIMITS.maxEntries) {
        throw new Error('本地插件文件数超过上限')
      }
      total += stat.size
      if (total > SECURITY_LIMITS.maxUnpackedBytes) throw new Error('本地插件总量超过上限')
      fileCount += 1
      const data = stat.size <= SECURITY_LIMITS.maxFileScanBytes ? await fs.readFile(full) : null
      entries.push({
        path: rel,
        type: 'file',
        size: stat.size,
        data,
        unsafe: false,
        linkPath: null
      })
    }
  }

  await walk(root)
  if (entries.length === 0) throw new Error('本地插件为空')
  return { entries, unpackedSize: total, fileCount }
}

async function checkFile(
  input: SecurityCheckInput,
  deps: Required<Pick<PluginSecurityCheckerDeps, 'fetcher' | 'now'>>,
  started: number
): Promise<PluginSecurityReport> {
  const raw = input.spec.replace(/^file:/i, '')
  const target = resolve(raw)
  let unpacked: UnpackedTarball
  try {
    const stat = await fs.stat(target)
    if (stat.isDirectory()) {
      unpacked = await readLocalEntries(target)
    } else {
      const bytes = await fs.readFile(target)
      if (bytes.byteLength > SECURITY_LIMITS.maxTarballBytes) {
        return unavailableReport(input.spec, started, deps.now, 'file')
      }
      unpacked = unpackTarball(bytes)
    }
  } catch {
    return unavailableReport(input.spec, started, deps.now, 'file')
  }
  const pkgEntry = packageJsonEntry(unpacked.entries)
  if (pkgEntry === null) {
    return blockedReport(
      input.spec,
      started,
      deps.now,
      'tarball.manifest-missing',
      'tarball.manifest-missing',
      emptyFacts('file')
    )
  }
  const manifest = manifestFromEntry(pkgEntry)
  if (manifest === null) {
    return blockedReport(
      input.spec,
      started,
      deps.now,
      'tarball.manifest-missing',
      'tarball.manifest-missing',
      emptyFacts('file')
    )
  }
  const scripts = scanScripts(manifest, true)
  const content = contentCheck(unpacked.entries)
  const dependencies = dependenciesCheck(manifest, content.nativeModules)
  const nameCheck = checkPluginName(
    manifest.name,
    input.installed.map((item) => item.name)
  )
  const facts = factsOf({
    source: 'file',
    registry: null,
    manifest,
    scripts: scripts.installScripts,
    nativeModules: content.nativeModules,
    unpackedSize: unpacked.unpackedSize,
    fileCount: unpacked.fileCount
  })
  const checks: PluginSecurityCheck[] = [
    checkOf('source', 'pass', 'source.local', { path: target }),
    checkOf('integrity', 'pass', 'integrity.local'),
    skippedCheck('reputation', 'reputation.partial'),
    checkOf('name', nameCheck.level, nameCheck.code, nameCheck.params, nameCheck.findings),
    checkOf(
      'scripts',
      scripts.level,
      scripts.code,
      { count: scripts.installScripts.length },
      scripts.findings
    ),
    content.check,
    dependencies.check,
    skippedCheck('vulnerabilities', 'vuln.unavailable')
  ]
  return buildReport({
    spec: input.spec,
    checks,
    findings: [
      ...nameCheck.findings,
      ...scripts.findings,
      ...content.findings,
      ...dependencies.findings
    ],
    facts,
    fingerprint: null,
    essentialComplete: true,
    partial: true,
    durationMs: Math.max(0, deps.now() - started),
    checkedAt: new Date(deps.now()).toISOString()
  })
}

/** 设置关闭时的报告：不访问网络，UI 显示「安全检查已关闭」。 */
export function disabledSecurityReport(spec: string): PluginSecurityReport {
  return {
    spec,
    verdict: 'disabled',
    checkedAt: new Date().toISOString(),
    durationMs: 0,
    fingerprint: null,
    essentialComplete: true,
    partial: false,
    checks: [],
    findings: [],
    facts: emptyFacts('npm')
  }
}

/** 创建检查器；报告内存缓存 10 分钟，同一 key 的并发请求共享一个 promise。 */
export function createPluginSecurityChecker(
  options: PluginSecurityCheckerDeps = {}
): PluginSecurityChecker {
  const fetcher = options.fetcher ?? defaultSecurityFetcher
  const now = options.now ?? Date.now
  const deps = { fetcher, now }
  const cache = new Map<string, { report: PluginSecurityReport; expiresAt: number }>()
  const inFlight = new Map<string, Promise<PluginSecurityReport>>()

  return {
    async check(input: SecurityCheckInput): Promise<PluginSecurityReport> {
      const key = `${input.spec}\u0000${input.registry}\u0000${input.installed
        .map((item) => `${item.name}@${item.version}`)
        .join(',')}`
      if (input.refresh !== true) {
        const hit = cache.get(key)
        if (hit !== undefined && hit.expiresAt > now()) return hit.report
      }
      const running = inFlight.get(key)
      if (running !== undefined) return running
      const task = (async (): Promise<PluginSecurityReport> => {
        const started = now()
        try {
          const kind = classifyPluginSpec(input.spec)
          const report =
            kind === 'npm'
              ? await checkNpm(input, deps, started)
              : kind === 'github'
                ? await checkGithub(input, deps, started)
                : await checkFile(input, deps, started)
          cache.set(key, { report, expiresAt: now() + REPORT_TTL_MS })
          return report
        } catch (error) {
          if (error instanceof InstanceStoreError) throw error
          const report = unavailableReport(input.spec, started, now, classifyPluginSpec(input.spec))
          cache.set(key, { report, expiresAt: now() + REPORT_TTL_MS })
          return report
        } finally {
          inFlight.delete(key)
        }
      })()
      // 总预算兜底：单个请求各有超时，但「元数据 → 并行可选检查 → tarball」串起来
      // 仍可能超过上限。到点先返回 unavailable（可确认后安装），后台任务不阻塞 UI。
      const started = now()
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<PluginSecurityReport>((resolve) => {
        timer = setTimeout(() => {
          const report = unavailableReport(input.spec, started, now, classifyPluginSpec(input.spec))
          cache.set(key, { report, expiresAt: now() + REPORT_TTL_MS })
          resolve(report)
        }, options.totalTimeoutMs ?? SECURITY_LIMITS.totalTimeoutMs)
      })
      const raced = Promise.race([task, timeout]).finally(() => {
        if (timer !== null) clearTimeout(timer)
      })
      inFlight.set(key, raced)
      return raced
    }
  }
}
