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
/** 有注释语法、需要先遮掉注释再匹配的脚本扩展名。 */
const SCRIPT_EXTENSIONS = /\.(?:js|cjs|mjs|ts|tsx|jsx)$/i
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
  /\bvm\.runIn(?:NewContext|ThisContext|Context)\s*\(/
]
/** 解码调用：只有出现在求值实参里，才把这次求值升级为混淆执行。 */
const DECODE_PATTERNS: RegExp[] = [
  /\batob\s*\(/,
  /Buffer\.from\s*\([\s\S]{0,500}?['"](?:base64|hex)['"]/i
]
/** 求值模式的并集，每个分支都以 `(` 结尾，便于截取实参。 */
const EVAL_CALL_SOURCE = EVAL_PATTERNS.map((pattern) => pattern.source).join('|')
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

/**
 * 词法扫描：注释替换成空格，同时给出一份把正则字面量内容也替换成空格的文本。
 *
 * 注释不执行，却常提到 `.npmrc`、`fetch(`、`undici` 这类词；按原文匹配会把
 * 「说明自己如何读 npm 配置」的文档注释当成凭据外发。替换成等长空白是为了让
 * 证据里的行号仍指向原文件。字符串与模板字面量保留：真实调用就在里面。
 *
 * 必须处理正则字面量：`/['"]?x/` 里的引号不是字符串起点，按引号切分会让扫描状态
 * 从这里失步，其后的注释遮不住。
 *
 * 正则体只是模式，不是路径、域名或调用：`/\.npmrc|\.ssh/` 这样的拒绝名单会被
 * 「敏感路径」规则误判。`literalFree` 把正则体换成等长空白，供路径、外发与求值
 * 等文本特征匹配；字符串与模板字面量仍保留。
 */
interface MaskedCode {
  code: string
  literalFree: string
}

function maskCode(text: string): MaskedCode {
  const chars = text.split('')
  const literalFree = text.split('')
  const isSpace = (char: string): boolean =>
    char === ' ' || char === '\t' || char === '\n' || char === '\r'
  const isWordChar = (char: string): boolean => /[A-Za-z0-9_$]/.test(char)
  const maskRange = (target: string[], from: number, to: number): void => {
    for (let cursor = from; cursor < to && cursor < target.length; cursor += 1) {
      if (target[cursor] !== '\n') target[cursor] = ' '
    }
  }
  /** 正则字面量起点：前一个有效记号是运算符、分隔符或 `return` 这类关键字。 */
  const regexPreceding = new Set([
    '=',
    '(',
    '[',
    '{',
    ',',
    ':',
    ';',
    '!',
    '&',
    '|',
    '?',
    '+',
    '-',
    '*',
    '%',
    '^',
    '~',
    '<',
    '>',
    ''
  ])
  const regexKeywords = new Set([
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'case',
    'do',
    'else',
    'yield',
    'await'
  ])
  /** 只用于遮正则体：`</` 在 JSX 里是闭合标签，不能当成正则起点。 */
  const literalPreceding = new Set([...regexPreceding].filter((token) => token !== '<'))
  const skipQuoted = (from: number, quote: string): number => {
    let cursor = from + 1
    while (cursor < text.length) {
      const char = text[cursor]
      if (char === '\\') {
        cursor += 2
        continue
      }
      cursor += 1
      if (char === quote) break
    }
    return cursor
  }
  const skipRegex = (from: number): number => {
    let cursor = from + 1
    let inClass = false
    while (cursor < text.length) {
      const char = text[cursor]
      if (char === '\n') return from + 1
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === '[') inClass = true
      else if (char === ']') inClass = false
      else if (char === '/' && !inClass) return cursor + 1
      cursor += 1
    }
    return cursor
  }

  /** 扫一段代码；模板字面量的 `${...}` 里会递归进来，`depth` 为花括号嵌套层数。 */
  const scanCode = (start: number, depth: number): number => {
    let index = start
    let previous = ''
    let word = ''
    while (index < text.length) {
      const char = text[index] as string
      const next = text[index + 1]
      if (depth >= 0 && char === '}' && --depth < 0) return index + 1
      if (char === '/' && next === '/') {
        const from = index
        while (index < text.length && text[index] !== '\n') index += 1
        maskRange(chars, from, index)
        maskRange(literalFree, from, index)
        previous = ''
        word = ''
        continue
      }
      if (char === '/' && next === '*') {
        const from = index
        index += 2
        while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
        index = Math.min(text.length, index + 2)
        maskRange(chars, from, index)
        maskRange(literalFree, from, index)
        previous = ''
        word = ''
        continue
      }
      if (char === '"' || char === "'") {
        index = skipQuoted(index, char)
        previous = 'v'
        word = ''
        continue
      }
      if (char === '`') {
        index += 1
        while (index < text.length) {
          const current = text[index]
          if (current === '\\') {
            index += 2
            continue
          }
          if (current === '`') {
            index += 1
            break
          }
          if (current === '$' && text[index + 1] === '{') {
            index = scanCode(index + 2, 0)
            continue
          }
          index += 1
        }
        previous = 'v'
        word = ''
        continue
      }
      if (char === '/' && (regexKeywords.has(word) || regexPreceding.has(previous))) {
        const start = index
        const end = skipRegex(index)
        // 先按原规则跳过正则体，保持注释识别状态；只有明确的起点才遮进 literalFree。
        if (regexKeywords.has(word) || literalPreceding.has(previous)) {
          maskRange(literalFree, start, end)
        }
        index = end
        previous = 'v'
        word = ''
        continue
      }
      if (isSpace(char)) {
        index += 1
        continue
      }
      if (isWordChar(char)) {
        const from = index
        while (index < text.length && isWordChar(text[index] as string)) index += 1
        word = text.slice(from, index)
        previous = 'v'
        continue
      }
      if (char === '{' && depth >= 0) depth += 1
      previous = char
      word = ''
      index += 1
    }
    return index
  }

  scanCode(0, -1)
  return { code: chars.join(''), literalFree: literalFree.join('') }
}
function lineOf(text: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

/** 从 `open`（指向左括号）截取到配对的右括号；超长或无配对时截到上限。 */
function callArguments(text: string, open: number, limit: number): string {
  const end = Math.min(text.length, open + limit)
  let depth = 0
  let index = open
  while (index < end) {
    const char = text[index] as string
    if (char === '"' || char === "'" || char === '`') {
      index = skipQuotedInCall(text, index, end)
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, index)
    }
    index += 1
  }
  return text.slice(open + 1, end)
}

function skipQuotedInCall(text: string, from: number, end: number): number {
  const quote = text[from] as string
  let index = from + 1
  while (index < end) {
    const char = text[index]
    if (char === '\\') {
      index += 2
      continue
    }
    index += 1
    if (char === quote) break
  }
  return index
}

/** 目标位置是否落在字符串或模板字面量内；注释与正则体已在词法遮罩阶段处理。 */
function isInsideString(text: string, target: number): boolean {
  let index = 0
  let quote: string | null = null
  while (index < target) {
    const char = text[index] as string
    if (quote !== null) {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    index += 1
  }
  return quote !== null
}

function hasDecodedArgument(text: string): boolean {
  for (const pattern of DECODE_PATTERNS) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    )
    let match: RegExpExecArray | null
    while ((match = global.exec(text)) !== null) {
      if (!isInsideString(text, match.index)) return true
    }
  }
  return false
}

interface EvalCall {
  index: number
  match: string
}

/**
 * 顺序检查求值调用。`first` 用于「动态求值」警告，`obfuscated` 只在对实参里发现
 * `atob(` 或 `Buffer.from(...,'base64')` 时给出。
 *
 * 同文件里同时出现 `new Function` 与内嵌 base64 是打包产物的常态：`setImmediate`
 * polyfill 的字符串回调构造、Emscripten 的具名函数包装，都会和内联 PNG/WOFF2/WASM
 * 资源落在同一个 bundle。按文件级共现会把这些判成混淆执行。这里截取每次求值的实参
 * （上限 8 KiB，最多看 50 处），要求解码调用出现在实参里，且不在字符串内。变量间接
 * 解码（先 `atob` 再 `eval(code)`）不在本规则范围。
 */
function scanEvalCalls(text: string): { first: EvalCall | null; obfuscated: EvalCall | null } {
  const callPattern = new RegExp(EVAL_CALL_SOURCE, 'g')
  let first: EvalCall | null = null
  let inspected = 0
  let found: RegExpExecArray | null
  while ((found = callPattern.exec(text)) !== null) {
    if (isInsideString(text, found.index)) continue
    const call = { index: found.index, match: found[0] }
    if (first === null) first = call
    if (inspected >= 50) break
    inspected += 1
    const open = call.index + call.match.lastIndexOf('(')
    if (hasDecodedArgument(callArguments(text, open, 8192))) {
      return { first, obfuscated: call }
    }
  }
  return { first, obfuscated: null }
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
    // 只对 JS/TS 做词法遮罩；JSON/YAML 没有注释与正则字面量，原文匹配。
    const masked = SCRIPT_EXTENSIONS.test(entry.path)
      ? maskCode(text)
      : { code: text, literalFree: text }
    const code = masked.code
    const literalFree = masked.literalFree

    const sensitive = firstMatch(literalFree, SENSITIVE_PATTERNS)
    const network = firstMatch(literalFree, NETWORK_PATTERNS)
    const evaluation = scanEvalCalls(literalFree)
    const exfil = firstMatch(literalFree, EXFIL_PATTERNS)
    const miner = firstMatch(literalFree, MINER_PATTERNS)

    if (sensitive !== null && network !== null) {
      addFinding(
        findings,
        'content.credential-exfil',
        'danger',
        evidenceOf(file, lineOf(code, sensitive.index), 'sensitive-read+network')
      )
    } else if (sensitive !== null && !minified) {
      addFinding(
        findings,
        'content.sensitive-read',
        'warn',
        evidenceOf(file, lineOf(code, sensitive.index), sensitive.match)
      )
    }
    if (evaluation.obfuscated !== null) {
      addFinding(
        findings,
        'content.obfuscated-eval',
        'danger',
        evidenceOf(file, lineOf(code, evaluation.obfuscated.index), 'eval+encoded')
      )
    } else if (evaluation.first !== null && !minified) {
      addFinding(
        findings,
        'content.dynamic-eval',
        'warn',
        evidenceOf(file, lineOf(code, evaluation.first.index), evaluation.first.match)
      )
    }
    if (exfil !== null) {
      addFinding(
        findings,
        'content.exfil-domain',
        'danger',
        evidenceOf(file, lineOf(code, exfil.index), exfil.match)
      )
    }
    if (miner !== null) {
      addFinding(
        findings,
        'content.miner',
        'danger',
        evidenceOf(file, lineOf(code, miner.index), miner.match)
      )
    }

    // 能力计数只统计非压缩代码，避免把客户端 bundle 里的第三方库算成作者代码。
    if (!minified) {
      capabilities.spawn += countMatches(literalFree, SPAWN_PATTERNS)
      capabilities.network += countMatches(literalFree, NETWORK_PATTERNS)
      capabilities.fs += countMatches(literalFree, FS_PATTERNS)
      capabilities.env += countMatches(literalFree, ENV_PATTERNS)
      capabilities.eval += countMatches(literalFree, EVAL_PATTERNS)
      capabilities.sensitive += countMatches(literalFree, SENSITIVE_PATTERNS)
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
