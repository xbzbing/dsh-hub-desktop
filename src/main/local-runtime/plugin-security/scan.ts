/**
 * tarball 静态扫描：安装脚本、依赖构成与代码特征。
 *
 * 只读文本，不执行任何内容。证据只保留「文件 + 行号 + 规则标签」，不回传源码，
 * 避免包内硬编码的凭据被二次展示或写日志。
 */
import { redactLine, redactSecret } from '@shared/redact'
import type { PluginSecurityEvidence, PluginSecurityFinding } from '@shared/contracts'
import type { TarEntry } from './tar'
import type { NpmVersionManifest } from './registry'
import { SECURITY_LIMITS } from './limits'

const TEXT_EXTENSIONS = /\.(?:js|cjs|mjs|ts|tsx|jsx|json|ya?ml)$/i
const NATIVE_EXTENSIONS = /\.(?:node|exe|dll|so|dylib)$/i

const SENSITIVE_PATTERNS: RegExp[] = [
  /\.ssh\b/i,
  /\.aws\b/i,
  /\.npmrc\b/i,
  /\.git-credentials\b/i,
  /\.kube[/\\]config/i,
  /\bid_(?:rsa|ed25519)\b/i,
  /Library[/\\]Keychains/i
]
const NETWORK_PATTERNS: RegExp[] = [
  /\bfetch\s*\(/,
  /require\(\s*['"](?:https?|net|dns|tls|http2)['"]/,
  /from\s+['"](?:https?|net|dns|tls|http2)['"]/,
  /\bhttps?\.request\b/,
  /\baxios\b/,
  /\bgot\s*\(/,
  /\bWebSocket\b/,
  /\bundici\b/
]
const EVAL_PATTERNS: RegExp[] = [
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /\bvm\.runIn(?:NewContext|ThisContext|Context)\b/
]
const ENCODED_PATTERNS: RegExp[] = [
  /Buffer\.from\([^)]*['"](?:base64|hex)['"]/i,
  /\batob\s*\(/,
  /[A-Za-z0-9+/]{240,}={0,2}/
]
const EXFIL_PATTERNS: RegExp[] = [
  /webhook\.site/i,
  /pastebin\.com/i,
  /transfer\.sh/i,
  /ngrok\.io/i,
  /discord(?:app)?\.com\/api\/webhooks/i,
  /api\.telegram\.org/i
]
const MINER_PATTERNS: RegExp[] = [/stratum\+tcp/i, /\bxmrig\b/i, /\bcoinhive\b/i, /cryptonight/i]
const SPAWN_PATTERNS: RegExp[] = [
  /child_process/,
  /\bexecSync\b/,
  /\bspawnSync\b/,
  /\bexecFileSync\b/,
  /\bspawn\s*\(/,
  /\bexec\s*\(/,
  /\bfork\s*\(/
]
const FS_PATTERNS: RegExp[] = [
  /\breadFile(?:Sync)?\s*\(/,
  /\breaddir(?:Sync)?\s*\(/,
  /\bcreateReadStream\s*\(/,
  /\bopenSync\s*\(/
]
const ENV_PATTERNS: RegExp[] = [/process\.env/]

const REMOTE_SCRIPT_PATTERNS: RegExp[] = [
  /(?:curl|wget)[^|\n]*\|\s*(?:sh|bash|zsh|node)\b/i,
  /(?:powershell|pwsh)[^\n]*(?:-enc|-encodedcommand|invoke-webrequest|\biwr\b)/i,
  /node\s+-e\s+[^\n]*(?:https?:|fetch\(|require\(\s*['"]https?)/i,
  /python[0-9.]*\s+-c\s+[^\n]*(?:urllib|requests)/i
]

export interface CapabilityCounts {
  spawn: number
  network: number
  fs: number
  env: number
  eval: number
  sensitive: number
}

export interface ContentScanResult {
  findings: PluginSecurityFinding[]
  capabilities: CapabilityCounts
  /** 包内原生二进制/构建文件。 */
  nativeModules: string[]
  /** 压缩/混淆产物数量（info，不直接算风险）。 */
  minifiedFiles: number
  scannedFiles: number
  /** 因超大/预算/条目上限未扫完。 */
  partial: boolean
}

interface FindingDraft {
  code: string
  level: 'info' | 'warn' | 'danger'
  evidence: PluginSecurityEvidence[]
  count: number
  refs: string[]
}

function evidenceOf(
  file: string | null,
  line: number | null,
  match: string | null
): PluginSecurityEvidence {
  return { file, line, match }
}

function displayPath(path: string): string {
  return path.startsWith('package/') ? path.slice('package/'.length) : path
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

function firstMatch(
  text: string,
  patterns: readonly RegExp[]
): { match: string; index: number } | null {
  let best: { match: string; index: number } | null = null
  for (const pattern of patterns) {
    const found = pattern.exec(text)
    if (found === null) continue
    if (best === null || found.index < best.index) {
      best = { match: found[0].slice(0, 80), index: found.index }
    }
  }
  return best
}

function countMatches(text: string, patterns: readonly RegExp[]): number {
  let total = 0
  for (const pattern of patterns) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    )
    const matches = text.match(global)
    if (matches !== null) total += matches.length
  }
  return total
}

function addFinding(
  findings: Map<string, FindingDraft>,
  code: string,
  level: 'info' | 'warn' | 'danger',
  evidence: PluginSecurityEvidence,
  refs: string[] = []
): void {
  const existing = findings.get(code)
  if (existing === undefined) {
    findings.set(code, { code, level, evidence: [evidence], count: 1, refs })
    return
  }
  existing.count += 1
  if (existing.evidence.length < 5) existing.evidence.push(evidence)
  for (const ref of refs) if (!existing.refs.includes(ref)) existing.refs.push(ref)
}

function isMinified(text: string): boolean {
  if (text.length < 50 * 1024) return false
  let maxLine = 0
  let lines = 1
  let current = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      if (current > maxLine) maxLine = current
      current = 0
      lines += 1
    } else {
      current += 1
    }
  }
  if (current > maxLine) maxLine = current
  return maxLine > 5000 || text.length / Math.max(lines, 1) > 500
}

/** 安装时会执行的脚本；GitHub 来源额外把 prepare 计入。 */
export function installScriptsOf(
  manifest: NpmVersionManifest,
  includePrepare: boolean
): Array<{ name: string; command: string }> {
  const names = includePrepare
    ? ['preinstall', 'install', 'postinstall', 'prepare']
    : ['preinstall', 'install', 'postinstall']
  return names
    .map((name) => ({ name, command: manifest.scripts[name] ?? '' }))
    .filter((item) => item.command !== '')
    .map((item) => ({
      name: item.name,
      command: redactSecret(redactLine(item.command)).slice(0, 240)
    }))
}

export function dependencyFacts(manifest: NpmVersionManifest): {
  directDependencies: number
  nonRegistryDependencies: string[]
} {
  const entries = Object.entries(manifest.dependencies)
  const nonRegistry = entries
    .filter(([, spec]) => /^(?:git\+|github:|https?:|file:|link:|workspace:)/i.test(spec))
    .map(([name]) => name)
  return { directDependencies: entries.length, nonRegistryDependencies: nonRegistry }
}

function scriptFindings(scripts: Array<{ name: string; command: string }>): {
  code: string
  level: 'pass' | 'warn' | 'danger'
  findings: PluginSecurityFinding[]
} {
  if (scripts.length === 0) return { code: 'scripts.none', level: 'pass', findings: [] }
  const remote = scripts.find((script) =>
    REMOTE_SCRIPT_PATTERNS.some((pattern) => pattern.test(script.command))
  )
  if (remote !== undefined) {
    return {
      code: 'scripts.remote-fetch',
      level: 'danger',
      findings: [
        {
          code: 'scripts.remote-fetch',
          level: 'danger',
          count: 1,
          evidence: [evidenceOf('package.json', null, remote.name)],
          refs: []
        }
      ]
    }
  }
  return {
    code: 'scripts.present',
    level: 'warn',
    findings: scripts.map((script) => ({
      code: 'scripts.present',
      level: 'warn' as const,
      count: 1,
      evidence: [evidenceOf('package.json', null, script.name)],
      refs: []
    }))
  }
}

/**
 * 扫描 tarball 内容。安装脚本与依赖事实由调用方单独扫描；这里只读文件。
 * 返回的 findings 已按 code 合并，evidence 最多 5 条。
 */
export function scanContent(entries: readonly TarEntry[]): ContentScanResult {
  const findings = new Map<string, FindingDraft>()
  const capabilities: CapabilityCounts = {
    spawn: 0,
    network: 0,
    fs: 0,
    env: 0,
    eval: 0,
    sensitive: 0
  }
  const nativeModules = entries
    .filter((entry) => NATIVE_EXTENSIONS.test(entry.path) || entry.path.endsWith('binding.gyp'))
    .map((entry) => displayPath(entry.path))
  let minifiedFiles = 0
  let scannedFiles = 0
  let scannedBytes = 0
  let partial = false
  const started = Date.now()

  for (const entry of entries) {
    if (entry.type !== 'file') continue
    if (!TEXT_EXTENSIONS.test(entry.path)) continue
    if (entry.data === null) {
      partial = true
      continue
    }
    if (scannedBytes + entry.size > SECURITY_LIMITS.maxTotalScanBytes) {
      partial = true
      break
    }
    if (Date.now() - started > SECURITY_LIMITS.maxScanMs) {
      partial = true
      break
    }
    const text = entry.data.toString('utf8')
    scannedBytes += entry.size
    scannedFiles += 1
    const minified = isMinified(text)
    if (minified) minifiedFiles += 1
    const file = displayPath(entry.path)

    const sensitive = firstMatch(text, SENSITIVE_PATTERNS)
    const network = firstMatch(text, NETWORK_PATTERNS)
    const evaluation = firstMatch(text, EVAL_PATTERNS)
    const encoded = firstMatch(text, ENCODED_PATTERNS)
    const exfil = firstMatch(text, EXFIL_PATTERNS)
    const miner = firstMatch(text, MINER_PATTERNS)

    if (sensitive !== null && network !== null) {
      addFinding(
        findings,
        'content.credential-exfil',
        'danger',
        evidenceOf(file, lineOf(text, sensitive.index), 'sensitive-read+network')
      )
    } else if (sensitive !== null && !minified) {
      addFinding(
        findings,
        'content.sensitive-read',
        'warn',
        evidenceOf(file, lineOf(text, sensitive.index), sensitive.match)
      )
    }
    if (evaluation !== null && encoded !== null) {
      addFinding(
        findings,
        'content.obfuscated-eval',
        'danger',
        evidenceOf(file, lineOf(text, evaluation.index), 'eval+encoded')
      )
    } else if (evaluation !== null && !minified) {
      addFinding(
        findings,
        'content.dynamic-eval',
        'warn',
        evidenceOf(file, lineOf(text, evaluation.index), evaluation.match)
      )
    }
    if (exfil !== null) {
      addFinding(
        findings,
        'content.exfil-domain',
        'danger',
        evidenceOf(file, lineOf(text, exfil.index), exfil.match)
      )
    }
    if (miner !== null) {
      addFinding(
        findings,
        'content.miner',
        'danger',
        evidenceOf(file, lineOf(text, miner.index), miner.match)
      )
    }

    // 能力计数只统计非压缩代码，避免把客户端 bundle 里的第三方库算成作者代码。
    if (!minified) {
      capabilities.spawn += countMatches(text, SPAWN_PATTERNS)
      capabilities.network += countMatches(text, NETWORK_PATTERNS)
      capabilities.fs += countMatches(text, FS_PATTERNS)
      capabilities.env += countMatches(text, ENV_PATTERNS)
      capabilities.eval += countMatches(text, EVAL_PATTERNS)
      capabilities.sensitive += countMatches(text, SENSITIVE_PATTERNS)
    }
  }

  for (const path of nativeModules) {
    addFinding(findings, 'content.native-binary', 'warn', evidenceOf(path, null, 'native'))
  }
  if (partial) {
    addFinding(findings, 'content.partial', 'info', evidenceOf(null, null, 'scan-budget'))
  }

  return {
    findings: [...findings.values()]
      .map((draft) => ({
        code: draft.code,
        level: draft.level,
        count: draft.count,
        evidence: draft.evidence,
        refs: draft.refs
      }))
      .sort((left, right) => levelWeight(right.level) - levelWeight(left.level)),
    capabilities,
    nativeModules,
    minifiedFiles,
    scannedFiles,
    partial
  }
}

function levelWeight(level: 'info' | 'warn' | 'danger'): number {
  return level === 'danger' ? 3 : level === 'warn' ? 2 : 1
}

/** 脚本检查结果（供编排层组装 check）。 */
export function scanScripts(
  manifest: NpmVersionManifest,
  includePrepare: boolean
): {
  level: 'pass' | 'warn' | 'danger'
  code: string
  findings: PluginSecurityFinding[]
  installScripts: Array<{ name: string; command: string }>
} {
  const installScripts = installScriptsOf(manifest, includePrepare)
  const result = scriptFindings(installScripts)
  return { ...result, installScripts }
}
