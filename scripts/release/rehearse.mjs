#!/usr/bin/env node
/**
 * 发布演练。
 *
 * 支持两种公开分发模式（见 `docs/release-policy.md`）：
 * - `source-only`：只发布 tag、发布说明与 GitHub 自动生成的源码归档；
 * - `windows-unsigned`：额外由 CI 在 windows-latest 上构建**未签名**的 Windows 安装包与校验和。
 *
 * macOS 二进制一律不发布（未签名未公证的 .app 在 Gatekeeper 下不可用）。脚本只做离线校验，
 * 推送 tag、创建/发布 Release 由人工与 CI 完成。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findPlaceholders, parseReleaseNotes } from './lib.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
/** @type {Array<{name: string, status: 'PASS'|'SKIP'|'FAIL', message?: string}>} */
const results = []

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

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

const pkg = JSON.parse(readText('package.json'))
const version = String(pkg.version)
const tag = `v${version}`
const builderYml = readText('electron-builder.yml')
const releaseNotesPath = `docs/releases/${tag}.md`

console.log(`\n=== DSH Hub 发布演练（版本 ${version}，标签 ${tag}）===\n`)

let notes = null
await check('版本号是合法 semver', () => {
  assert(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    `package.json version="${version}" 不是合法 semver`
  )
})

await check(`发布说明 ${releaseNotesPath} 可解析`, () => {
  notes = parseReleaseNotes(readText(releaseNotesPath))
})

if (notes) {
  await check('发布说明版本与 package.json 一致', () => {
    assert(notes.version === version, `发布说明写的是 v${notes.version}，package.json 是 v${version}`)
  })
  await check('发布说明日期格式正确', () => {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(notes.date), `发布日期 "${notes.date}" 不是 YYYY-MM-DD`)
  })
  await check('发布说明的分发方式与资产清单自洽', () => {
    assert(
      notes.distribution === 'source-only' || notes.distribution === 'windows-unsigned',
      `未知分发方式：${notes.distribution}`
    )
    if (notes.distribution === 'source-only') {
      assert(notes.artifacts.length === 0, `source-only 发布说明声明了资产：${notes.artifacts.join(', ')}`)
      return
    }
    // windows-unsigned：资产名必须与 CI 实际产出的 NSIS 安装包一致
    assert(
      notes.artifacts.includes(`DSH-Hub-Setup-${version}.exe`),
      `windows-unsigned 发布说明缺少安装包资产：DSH-Hub-Setup-${version}.exe`
    )
    assert(notes.artifacts.includes('SHA256SUMS.txt'), 'windows-unsigned 发布说明缺少 SHA256SUMS.txt')
  })
  await check('发布说明声明的 Windows 资产有可执行的流水线', () => {
    if (notes.distribution !== 'windows-unsigned') return
    const workflow = '.github/workflows/release.yml'
    assert(existsSync(join(ROOT, workflow)), `windows-unsigned 需要 ${workflow}`)
    const text = readText(workflow)
    assert(/dist:win/.test(text), `${workflow} 未调用 dist:win`)
    assert(/release:checksums/.test(text), `${workflow} 未生成校验和清单`)
  })
  await check('发布说明不含占位符', () => {
    const found = findPlaceholders(readText(releaseNotesPath))
    assert(found.length === 0, `发布说明残留占位符：${found.join(' / ')}`)
  })
}

await check('electron-builder 不配置 GitHub publish provider', () => {
  assert(!/^publish:\s*$/m.test(builderYml), 'electron-builder.yml 不得配置 publish')
  assert(!/^\s*provider:\s*github\s*$/m.test(builderYml), 'electron-builder.yml 不得配置 GitHub provider')
})

await check('本地打包脚本一律 --publish never', () => {
  for (const name of ['dist', 'dist:mac', 'dist:mac:zip', 'dist:win']) {
    const script = pkg.scripts[name]
    assert(typeof script === 'string', `package.json 缺少脚本 ${name}`)
    assert(script.includes('--publish never'), `脚本 ${name} 未带 --publish never：${script}`)
  }
})

await check('零运行时依赖', () => {
  const deps = pkg.dependencies ?? {}
  assert(Object.keys(deps).length === 0, `运行时依赖不为空：${Object.keys(deps).join(', ')}`)
})

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

let remoteUrl = null
try {
  remoteUrl = git(['remote', 'get-url', 'origin'])
} catch {
  remoteUrl = null
}
if (remoteUrl === null || remoteUrl === '') {
  skip('远端 tag 推送演练', '本仓库没有 origin remote（纯本地仓库）—— 创建 GitHub 仓库后再执行下方命令')
} else {
  await check('origin remote 已配置', () => {
    assert(remoteUrl.length > 0, 'origin remote 为空')
  })
}

const failed = results.filter((item) => item.status === 'FAIL')
const skipped = results.filter((item) => item.status === 'SKIP')
const passed = results.length - failed.length - skipped.length
console.log(`\n=== 汇总：PASS ${passed} / SKIP ${skipped.length} / FAIL ${failed.length} ===`)

const windowsMode = notes !== null && notes.distribution === 'windows-unsigned'
console.log(`\n--- 人工收口步骤（${windowsMode ? 'windows-unsigned' : 'source-only'}；脚本不代做）---`)
console.log(`  1) git tag -a ${tag} -m "DSH Hub ${version}" && git push origin ${tag}`)
if (windowsMode) {
  console.log('  2) 推送 tag 后由 .github/workflows/release.yml 在 windows-latest 上构建安装包，')
  console.log('     创建 Draft Release 并上传 `DSH-Hub-Setup-' + version + '.exe` 与 SHA256SUMS.txt')
  console.log('  3) 在 GitHub 上确认 Draft Release 的资产与校验和，再点击 Publish release')
} else {
  console.log(`  2) gh release create ${tag} --draft \\`)
  console.log(`       --title "DSH Hub ${version}" \\`)
  console.log(`       --notes-file ${releaseNotesPath}`)
  console.log('  3) 在 GitHub 上确认 Draft Release 只保留 Release Note 与自动生成的源码归档，再点击 Publish release')
}
console.log('\n  不上传 .app、.dmg、.zip（macOS 二进制）或 latest-*.yml（自动更新元数据）。')
console.log('  macOS 本地打包仅用于开发、本机验证和受控测试；恢复 macOS 二进制发行前须满足 docs/release-policy.md 的签名与公证条件。')

if (failed.length > 0) {
  console.log('\n发布演练失败：')
  for (const item of failed) console.log(`  · ${item.name}：${item.message}`)
  process.exit(1)
}
console.log('\n发布演练通过（source-only 离线校验部分全绿）。')
