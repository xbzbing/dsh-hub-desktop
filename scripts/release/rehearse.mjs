#!/usr/bin/env node
/**
 * 可执行的发布验证。
 *
 * 把「发布」拆成两类步骤：
 * - **能离线演练的**：版本/发布说明/打包配置一致性、更新元数据与产物的字节级自洽、
 *   校验和清单、tag 与版本的对应关系 —— 这些在这里机械校验，任一不符即非零退出。
 * - **必须有真实远端/证书的**：推送 tag、创建 GitHub Release、签名与公证、Windows 产物、
 *   自动更新的端到端升级 —— 脚本只**打印确切命令**并显式标记 SKIP，绝不假装通过。
 *
 * 用法：
 *   node scripts/release/rehearse.mjs            # 打包后跑：全量校验
 *   node scripts/release/rehearse.mjs --pre      # 打包前跑：只校验版本/说明/配置
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { collectArtifacts } from './checksums.mjs'
import {
  findPlaceholders,
  normalizeArtifactUrl,
  parseReleaseNotes,
  parseUpdateYaml,
  verifyUpdateMetadata
} from './lib.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const DIST = join(ROOT, 'dist')
const PRE_ONLY = process.argv.includes('--pre')
const UPDATE_METADATA_NAMES = ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']

/** @type {Array<{name: string, status: 'PASS'|'SKIP'|'FAIL', message?: string}>} */
const results = []

/** 统一的 PASS/FAIL 记账；`fn` 抛错即 FAIL（抛错的 message 会原样打出来，便于定位） */
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, status: 'PASS' })
    console.log(`PASS  ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, status: 'FAIL', message })
    console.log(`FAIL  ${name}\n      ${message}`)
  }
}

/** 显式跳过：绝不把「没做」记成「通过」 */
function skip(name, why) {
  results.push({ name, status: 'SKIP', message: why })
  console.log(`SKIP  ${name}\n      ${why}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readText(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

async function exists(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

async function digestBase64(algorithm, path) {
  const hash = createHash(algorithm)
  hash.update(readFileSync(path))
  return hash.digest('base64')
}

/**
 * 元数据里的 url 是「空格→连字符」形态，磁盘上是原名（含空格）。
 * 两边都归一化到「连字符形态」再比，方向无关 —— 直接对 url 做替换是错的
 * （连字符形态里没有空格，替换等于没做）。
 */
function resolveArtifactPath(url) {
  const target = normalizeArtifactUrl(url)
  for (const name of readdirSync(DIST)) {
    if (name === target || normalizeArtifactUrl(name) === target) return join(DIST, name)
  }
  return null
}

function isFile(path) {
  if (!existsSync(path)) return false
  return statSync(path).isFile()
}

const pkg = JSON.parse(readText('package.json'))
const version = String(pkg.version)
const tag = `v${version}`
const builderYml = readText('electron-builder.yml')

console.log(`\n=== DSH Hub 发布演练（版本 ${version}，标签 ${tag}）===\n`)

// ---- 1. 版本号 / 发布说明（离线可校验：即使尚未打包也应通过） ----
let notes = null

await check('版本号是合法 semver', () => {
  assert(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    `package.json version="${version}" 不是合法 semver`
  )
})

await check(`发布说明 docs/releases/${tag}.md 可解析`, () => {
  notes = parseReleaseNotes(readText(`docs/releases/${tag}.md`))
})

if (notes) {
  await check('发布说明版本与 package.json 一致', () => {
    assert(
      notes.version === version,
      `发布说明写的是 v${notes.version}，package.json 是 v${version}`
    )
  })
  await check('发布说明日期格式正确', () => {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(notes.date), `发布日期 "${notes.date}" 不是 YYYY-MM-DD`)
  })
  await check('发布说明不含占位符', () => {
    const found = findPlaceholders(readText(`docs/releases/${tag}.md`))
    assert(found.length === 0, `发布说明残留占位符：${found.join(' / ')}`)
  })
}

// ---- 2. 打包与发布配置（离线可校验） ----
await check('更新元数据 provider 已配置且只创建草稿', () => {
  assert(/^\s*provider:\s*github\s*$/m.test(builderYml), 'electron-builder.yml 缺少 publish.provider: github')
  assert(
    /^\s*releaseType:\s*draft\s*$/m.test(builderYml),
    'releaseType 必须为 draft（发布流程只创建草稿，人工确认后转正）'
  )
  assert(
    /^\s*owner:\s*\S+/m.test(builderYml),
    'publish 缺少 owner（本仓库无 remote，provider 无法推断，必须显式声明）'
  )
  assert(/^\s*repo:\s*\S+/m.test(builderYml), 'publish 缺少 repo')
})

await check('本地打包脚本一律 --publish never（结构上不可能误发布）', () => {
  for (const name of ['dist', 'dist:mac', 'dist:mac:zip', 'dist:win']) {
    const script = pkg.scripts[name]
    assert(typeof script === 'string', `package.json 缺少脚本 ${name}`)
    assert(script.includes('--publish never'), `脚本 ${name} 未带 --publish never：${script}`)
  }
})

await check('零运行时依赖（dependencies 为空）', () => {
  const deps = pkg.dependencies ?? {}
  assert(Object.keys(deps).length === 0, `运行时依赖不为空：${Object.keys(deps).join(', ')}`)
})

// ---- 3. 更新元数据 ↔ 产物（需先打包） ----
if (PRE_ONLY) {
  skip('更新元数据与产物字节级自洽', '--pre 模式：尚未打包，无可校验产物')
} else {
  const metadataPath = (
    await Promise.all(
      UPDATE_METADATA_NAMES.map(async (name) =>
        (await exists(join(DIST, name))) ? join(DIST, name) : null
      )
    )
  ).find((path) => path !== null)

  if (metadataPath === undefined || metadataPath === null) {
    skip(
      '更新元数据与产物字节级自洽',
      `dist/ 下没有 ${UPDATE_METADATA_NAMES.join(' / ')} —— 先执行 pnpm dist:mac:zip`
    )
  } else {
    const metadata = parseUpdateYaml(readFileSync(metadataPath, 'utf8'))
    const missing = []
    const artifacts = []
    for (const entry of metadata.files) {
      const full = resolveArtifactPath(entry.url)
      if (full === null) {
        missing.push(entry.url)
        continue
      }
      artifacts.push({
        name: entry.url,
        sha512: await digestBase64('sha512', full),
        size: statSync(full).size
      })
    }
    const label = metadataPath.slice(ROOT.length + 1)

    await check(`更新元数据引用的产物都存在（${label}）`, () => {
      assert(missing.length === 0, `元数据引用了磁盘上不存在的产物：${missing.join(', ')}`)
    })
    await check(`更新元数据与产物字节级自洽（${label}）`, () => {
      const verdict = verifyUpdateMetadata({ metadata, appVersion: version, artifacts })
      assert(verdict.ok, verdict.problems.join('；'))
    })
  }

  // ---- 4. 校验和清单 ↔ 实际字节 ----
  const sumsPath = join(DIST, 'SHA256SUMS.txt')
  if (!(await exists(sumsPath))) {
    skip('SHA256SUMS.txt 与实际字节一致', 'dist/SHA256SUMS.txt 不存在 —— 先执行 pnpm release:checksums')
  } else {
    await check('SHA256SUMS.txt 与实际字节一致', async () => {
      const lines = readFileSync(sumsPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
      assert(lines.length > 0, 'SHA256SUMS.txt 为空')
      const manifestNames = new Set()
      for (const line of lines) {
        const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line)
        assert(match !== null, `无法解析的校验和行：${line}`)
        const [, digest, name] = match
        assert(!manifestNames.has(name), `SHA256SUMS.txt 包含重复条目：${name}`)
        manifestNames.add(name)
        const full = join(DIST, name)
        assert(isFile(full), `校验和清单里的 ${name} 不存在`)
        const actual = createHash('sha256').update(readFileSync(full)).digest('hex')
        assert(actual === digest, `${name} 的 sha256 不匹配（清单 ${digest} ≠ 实际 ${actual}）`)
      }
      const artifacts = await collectArtifacts(DIST)
      const artifactNames = new Set(artifacts.map((artifact) => artifact.name))
      assert(
        manifestNames.size === artifactNames.size && [...artifactNames].every((name) => manifestNames.has(name)),
        `SHA256SUMS.txt 与应分发产物不一致（清单：${[...manifestNames].join(', ')}；产物：${[...artifactNames].join(', ')}）`
      )
    })
  }
}

// ---- 5. tag ↔ 版本（发布时才成立） ----
let headTag = null
try {
  headTag = git(['describe', '--tags', '--exact-match'])
} catch {
  headTag = null
}
if (headTag === null) {
  skip(`HEAD 处于 ${tag} 标签上`, '当前提交没有精确匹配的 tag（发布时才打标签，属预期）')
} else {
  await check(`HEAD 标签等于 ${tag}`, () => {
    assert(headTag === tag, `HEAD 上的 tag 是 ${headTag}，与 package.json 版本的 ${tag} 不一致`)
  })
}

// ---- 6. 远端（本仓库为纯本地仓库） ----
let remoteUrl = null
try {
  remoteUrl = git(['remote', 'get-url', 'origin'])
} catch {
  remoteUrl = null
}
if (remoteUrl === null || remoteUrl === '') {
  skip(
    '远端 tag 推送演练',
    '本仓库没有 origin remote（纯本地仓库）—— 需先创建 GitHub 仓库；命令见下方人工步骤'
  )
} else {
  await check('origin remote 已配置', () => {
    assert(remoteUrl.length > 0, 'origin remote 为空')
  })
}

// ---- 汇总 ----
const failed = results.filter((item) => item.status === 'FAIL')
const skipped = results.filter((item) => item.status === 'SKIP')
const passed = results.length - failed.length - skipped.length
console.log(`\n=== 汇总：PASS ${passed} / SKIP ${skipped.length} / FAIL ${failed.length} ===`)

const declaredAssets = notes?.artifacts ?? [`DSH Hub-${version}-arm64-mac.zip`]
// 只把**真实存在**的产物放进命令里 —— 否则照着粘贴出来的 gh 会直接报错。
// 尚未构建的目标单独列出，明确要求补齐而不是悄悄少传。
const presentAssets = declaredAssets.filter((name) => isFile(join(DIST, name)))
const absentAssets = declaredAssets.filter((name) => !presentAssets.includes(name))

console.log('\n--- 人工收口步骤（需真实远端/证书，脚本不代做）---')
console.log(`  1) git tag -a ${tag} -m "DSH Hub ${version}" && git push origin ${tag}`)
console.log(`  2) gh release create ${tag} --draft --title "DSH Hub ${version}" \\`)
console.log(`       --notes-file docs/releases/${tag}.md \\`)
for (const name of presentAssets) console.log(`       "dist/${name}" \\`)
console.log('  3) 在 GitHub 上人工确认草稿内容后点击 Publish release')
if (absentAssets.length > 0) {
  console.log('\n  ⚠ 以下产物在发布说明里声明了但 dist/ 下还没有，补齐后重新生成本命令：')
  for (const name of absentAssets) console.log(`      · ${name}`)
}

console.log('\n--- 当前环境无法验证的项目 ---')
console.log('  · 代码签名与公证：无 Apple Developer 证书，产物未签名（只宜自用）')
console.log('  · Windows NSIS 产物：需 Windows 或 wine 环境')
console.log('  · 自动更新端到端：需真实远端和已安装的先前版本，本机无法验证')
console.log('  · dmg 产物：本机网络对 dmg 附加依赖不稳，当前只产出 zip')

if (failed.length > 0) {
  console.log('\n发布演练失败：')
  for (const item of failed) console.log(`  · ${item.name}：${item.message}`)
  process.exit(1)
}
console.log('\n发布演练通过（离线可校验部分全绿）。')
