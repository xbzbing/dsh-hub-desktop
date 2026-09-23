#!/usr/bin/env node
/**
 * 发布演练。
 *
 * 公开发布只用 `source-only` 分发模式（见 `docs/release-policy.md`）：
 * 只发布 tag、发布说明与 GitHub 自动生成的源码归档，不上传任何二进制资产。
 * 脚本只做离线校验，推送 tag、创建/发布 Release 由人工完成。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
    assert(notes.distribution === 'source-only', `未知分发方式：${notes.distribution}`)
    assert(notes.artifacts.length === 0, `source-only 发布说明声明了资产：${notes.artifacts.join(', ')}`)
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

console.log(`\n--- 人工收口步骤（source-only；脚本不代做）---`)
console.log(`  1) git tag -a ${tag} -m "DSH Hub ${version}" && git push origin ${tag}`)
console.log(`  2) gh release create ${tag} --draft \\`)
console.log(`       --title "DSH Hub ${version}" \\`)
console.log(`       --notes-file ${releaseNotesPath}`)
console.log('  3) 在 GitHub 上确认 Draft Release 只保留 Release Note 与自动生成的源码归档，再点击 Publish release')
console.log('\n  不上传任何二进制资产：.exe、.app、.dmg、.zip、SHA256SUMS.txt、latest-*.yml 一律不上传。')
console.log('  本地打包仅用于开发、本机验证和受控测试；恢复二进制发行前须满足 docs/release-policy.md 的签名与公证条件。')

if (failed.length > 0) {
  console.log('\n发布演练失败：')
  for (const item of failed) console.log(`  · ${item.name}：${item.message}`)
  process.exit(1)
}
console.log('\n发布演练通过（source-only 离线校验部分全绿）。')
