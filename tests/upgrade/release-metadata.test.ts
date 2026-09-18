import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findPlaceholders,
  normalizeArtifactUrl,
  parseReleaseNotes,
  parseUpdateYaml,
  verifyUpdateMetadata,
  type UpdateMetadata
} from '../../scripts/release/lib.mjs'

/**
 * 发布元数据的**离线验证**。
 *
 * 发布相关的东西错在哪都很难发现:版本号漏改、发布说明与产物对不上、更新元数据里的
 * sha512 与实际字节不符 —— 这些在本地「看起来都正常」,只有用户更新失败时才会暴露。
 * 所以把能离线判定的部分放进 `pnpm test`,让它在每次提交时自动跑。
 *
 * 需要真实远端/证书的部分(签名、推送、自动更新闭环)刻意**不**在这里假装通过,
 * 由 `scripts/release/rehearse.mjs` 显式标 SKIP,并在本地发布演练文档(不进 git)记账。
 */

const ROOT = process.cwd()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string
  dependencies?: Record<string, string>
  scripts: Record<string, string>
}
const version = pkg.version
const tag = `v${version}`

function readText(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

describe('版本与发布说明一致性', () => {
  it('package.json 版本是合法 semver', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })

  it('当前版本存在对应的发布说明,且版本号一致', () => {
    const notes = parseReleaseNotes(readText(`docs/releases/${tag}.md`))
    expect(notes.version).toBe(version)
    expect(notes.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('发布说明不含占位符', () => {
    expect(findPlaceholders(readText(`docs/releases/${tag}.md`))).toEqual([])
  })

  it('发布说明的产物清单覆盖所有已声明的打包目标', () => {
    const notes = parseReleaseNotes(readText(`docs/releases/${tag}.md`))
    // 安装包（zip/dmg/exe）必须带版本号,否则不同版本的附件会互相覆盖;
    // 更新元数据与校验和清单是固定文件名,天然不含版本号,按设计豁免。
    const installers = notes.artifacts.filter((name) => /\.(zip|dmg|exe)$/.test(name))
    expect(installers.length).toBeGreaterThanOrEqual(3)
    for (const name of installers) {
      expect(name, `安装包名 ${name} 缺少版本号`).toContain(version)
    }
    const joined = notes.artifacts.join('\n')
    // mac: dmg + zip
    expect(joined).toMatch(/\.dmg/)
    expect(joined).toMatch(/\.zip/)
    // win: nsis → .exe
    expect(joined).toMatch(/\.exe/)
    // 自动更新的更新元数据
    expect(joined).toMatch(/latest-mac\.yml/)
    expect(joined).toMatch(/SHA256SUMS\.txt/)
  })

  it('发布说明明确标注哪些产物尚未构建(不许暗示已产出)', () => {
    const text = readText(`docs/releases/${tag}.md`)
    expect(text).toContain('未构建')
  })
})

describe('打包与发布配置', () => {
  const yml = readText('electron-builder.yml')

  it('更新元数据 provider 为 github 且只创建草稿', () => {
    expect(yml).toMatch(/^\s*provider:\s*github\s*$/m)
    expect(yml).toMatch(/^\s*releaseType:\s*draft\s*$/m)
    // 仓库无 git remote,provider 无法推断,owner/repo 必须显式
    expect(yml).toMatch(/^\s*owner:\s*\S+/m)
    expect(yml).toMatch(/^\s*repo:\s*\S+/m)
  })

  it('本地打包脚本结构上不可能误发布', () => {
    for (const name of ['dist', 'dist:mac', 'dist:mac:zip', 'dist:win']) {
      expect(pkg.scripts[name], `缺少脚本 ${name}`).toBeTruthy()
      expect(pkg.scripts[name], `脚本 ${name} 必须带 --publish never`).toContain('--publish never')
    }
    // 发布只能通过 release 脚本显式进行
    expect(pkg.scripts['release:check']).toBeTruthy()
    expect(pkg.scripts['release:checksums']).toBeTruthy()
  })

  it('包内容白名单不含源码/测试/文档', () => {
    expect(yml).toMatch(/files:/)
    expect(yml).toMatch(/-\s*out\/\*\*/)
    expect(yml).not.toMatch(/-\s*src\/\*\*/)
    expect(yml).not.toMatch(/-\s*tests\/\*\*/)
    expect(yml).not.toMatch(/-\s*docs\/\*\*/)
  })

  it('使用设计稿生成的 macOS 与 Windows 应用图标', () => {
    expect(yml).toMatch(/^\s*icon:\s*build\/icon\.icns\s*$/m)
    expect(yml).toMatch(/^\s*icon:\s*build\/icon\.ico\s*$/m)
    expect(existsSync(join(ROOT, 'design', 'dsh-hub-logo.svg'))).toBe(true)
    expect(existsSync(join(ROOT, 'build', 'icon.icns'))).toBe(true)
    expect(existsSync(join(ROOT, 'build', 'icon.ico'))).toBe(true)
  })

  it('macOS 本地打包复用已安装的 Electron 分发包，不依赖下载', () => {
    expect(yml).toMatch(/^electronDist:\s*node_modules\/electron\/dist\s*$/m)
  })

  it('零运行时依赖', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([])
  })
})

describe('更新元数据解析与校验', () => {
  /** 与 electron-builder 实际产出同形态:注意 url 里的空格已被换成连字符 */
  const sampleYaml = [
    'version: 0.1.0',
    'files:',
    '  - url: DSH-Hub-0.1.0-arm64-mac.zip',
    '    sha512: AAAABBBB',
    '    size: 120994809',
    "path: DSH-Hub-0.1.0-arm64-mac.zip",
    'sha512: AAAABBBB',
    "releaseDate: '2026-09-15T20:24:52.305Z'"
  ].join('\n')

  it('解析 electron-builder 的更新元数据形态', () => {
    const metadata = parseUpdateYaml(sampleYaml)
    expect(metadata.version).toBe('0.1.0')
    expect(metadata.files).toHaveLength(1)
    expect(metadata.files[0]).toEqual({
      url: 'DSH-Hub-0.1.0-arm64-mac.zip',
      sha512: 'AAAABBBB',
      size: 120994809
    })
    expect(metadata.path).toBe('DSH-Hub-0.1.0-arm64-mac.zip')
    expect(metadata.sha512).toBe('AAAABBBB')
    expect(metadata.releaseDate).toBe('2026-09-15T20:24:52.305Z')
  })

  it('畸形/缺字段的元数据必须抛错而不是静默放行', () => {
    expect(() => parseUpdateYaml('')).toThrow()
    expect(() => parseUpdateYaml('files:\n  - url: a.zip\n    sha512: x\n')).toThrow(/version/)
    expect(() => parseUpdateYaml('version: 0.1.0\nfiles: []\n')).toThrow(/files/)
    expect(() => parseUpdateYaml('version: 0.1.0\nfiles:\n  - url: a.zip\n')).toThrow(/sha512/)
  })

  it('磁盘产物名带空格、元数据 url 带连字符时仍能对上', () => {
    // electron-builder 把空格换成连字符写进 URL,磁盘上是 'DSH Hub-0.1.0-arm64-mac.zip'
    expect(normalizeArtifactUrl('DSH-Hub-0.1.0-arm64-mac.zip')).toBe(
      'DSH-Hub-0.1.0-arm64-mac.zip'
    )
    expect(normalizeArtifactUrl('DSH%20Hub-0.1.0-arm64-mac.zip')).toBe(
      'DSH-Hub-0.1.0-arm64-mac.zip'
    )
    expect(normalizeArtifactUrl('https://example.com/x/DSH Hub-0.1.0.zip')).toBe(
      'DSH-Hub-0.1.0.zip'
    )

    const metadata = parseUpdateYaml(sampleYaml)
    const verdict = verifyUpdateMetadata({
      metadata,
      appVersion: '0.1.0',
      // 磁盘实测:原名带空格,sha512/size 与元数据一致
      artifacts: [
        { name: 'DSH Hub-0.1.0-arm64-mac.zip', sha512: 'AAAABBBB', size: 120994809 }
      ]
    })
    expect(verdict.problems).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  it('版本不一致 / sha512 不一致 / 产物缺失 / 顶层字段不一致 全部能被检出', () => {
    const metadata = parseUpdateYaml(sampleYaml)
    const good = [{ name: 'DSH-Hub-0.1.0-arm64-mac.zip', sha512: 'AAAABBBB', size: 120994809 }]

    const versionMismatch = verifyUpdateMetadata({
      metadata,
      appVersion: '0.2.0',
      artifacts: good
    })
    expect(versionMismatch.ok).toBe(false)
    expect(versionMismatch.problems.join()).toMatch(/版本不一致/)

    const hashMismatch = verifyUpdateMetadata({
      metadata,
      appVersion: '0.1.0',
      artifacts: [{ name: 'DSH-Hub-0.1.0-arm64-mac.zip', sha512: 'WRONG', size: 120994809 }]
    })
    expect(hashMismatch.ok).toBe(false)
    expect(hashMismatch.problems.join()).toMatch(/sha512 不匹配/)

    const sizeMismatch = verifyUpdateMetadata({
      metadata,
      appVersion: '0.1.0',
      artifacts: [{ name: 'DSH-Hub-0.1.0-arm64-mac.zip', sha512: 'AAAABBBB', size: 1 }]
    })
    expect(sizeMismatch.ok).toBe(false)
    expect(sizeMismatch.problems.join()).toMatch(/size 不匹配/)

    const missing = verifyUpdateMetadata({ metadata, appVersion: '0.1.0', artifacts: [] })
    expect(missing.ok).toBe(false)
    expect(missing.problems.join()).toMatch(/不存在的产物/)

    const topLevelBroken: UpdateMetadata = { ...metadata, path: 'other.zip' }
    const topLevel = verifyUpdateMetadata({
      metadata: topLevelBroken,
      appVersion: '0.1.0',
      artifacts: good
    })
    expect(topLevel.ok).toBe(false)
    expect(topLevel.problems.join()).toMatch(/顶层 path/)
  })
})

describe('已构建产物与更新元数据端到端自洽', () => {
  const distDir = join(ROOT, 'dist')
  const metadataPath = join(distDir, 'latest-mac.yml')
  const hasMetadata = existsSync(metadataPath)

  it.skipIf(!hasMetadata)('dist/latest-mac.yml 的 version/sha512/size 与实际产物一致', () => {
    const metadata = parseUpdateYaml(readFileSync(metadataPath, 'utf8'))
    const artifacts = metadata.files.map((entry) => {
      // 元数据 url 是「空格→连字符」形态,磁盘上是原名(含空格)。
      // 必须**扫描目录后按归一化名比对**,方向无关 —— 直接对 url 做空格替换是错的
      // (连字符形态里没有空格,替换等于没做)。
      const target = normalizeArtifactUrl(entry.url)
      const name = readdirSync(distDir).find((candidate) => normalizeArtifactUrl(candidate) === target)
      expect(name, `元数据引用的产物在 dist/ 下不存在:${entry.url}`).toBeTruthy()
      const full = join(distDir, name!)
      const bytes = readFileSync(full)
      return {
        name: entry.url,
        sha512: createHash('sha512').update(bytes).digest('base64'),
        size: statSync(full).size
      }
    })
    const verdict = verifyUpdateMetadata({ metadata, appVersion: version, artifacts })
    expect(verdict.problems).toEqual([])
  })
})

describe('checksums 清单只收分发产物', () => {
  it('点文件与 builder 调试输出不入清单(手工下载者的校验和只引用会上传的文件)', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { collectArtifacts } = await import('../../scripts/release/checksums.mjs')
    const dir = mkdtempSync(join(tmpdir(), 'sums-exclude-'))
    // 应收录
    writeFileSync(join(dir, 'DSH Hub-0.1.0-arm64-mac.zip'), 'zip-bytes')
    writeFileSync(join(dir, 'latest-mac.yml'), 'yml')
    // 应排除:macOS 点文件 / builder 调试 / 差分中间产物 / 清单自身 / 目录
    writeFileSync(join(dir, '.DS_Store'), 'junk')
    writeFileSync(join(dir, 'builder-debug.yml'), 'debug')
    writeFileSync(join(dir, 'DSH Hub-0.1.0-arm64-mac.zip.blockmap'), 'diff')
    writeFileSync(join(dir, 'SHA256SUMS.txt'), 'self')
    mkdirSync(join(dir, 'mac-arm64'))
    const files = await collectArtifacts(dir)
    const names = files.map((file) => file.name)
    expect(names).toEqual(['DSH Hub-0.1.0-arm64-mac.zip', 'latest-mac.yml'])
  })
})
