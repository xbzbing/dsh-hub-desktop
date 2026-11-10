#!/usr/bin/env node
/**
 * 检查锁定的 Electron 版本是否落后于同 major 的最新补丁。
 *
 * 只读 npm registry 的 dist-tags，不安装、不修改文件；定时 workflow 与
 * `pnpm check:electron` 共用。跨 major 升级不在本脚本的判定范围。
 */
import { readFile } from 'node:fs/promises'

const REGISTRY = 'https://registry.npmjs.org/-/package/electron/dist-tags'
const TIMEOUT_MS = 15_000
const EXIT_BEHIND = 1
const EXIT_ERROR = 2

function fail(message) {
  console.error(`Electron 补丁检查失败：${message}`)
  process.exit(EXIT_ERROR)
}

/** 解析精确版本（可带 v 前缀或预发布后缀）为数字三元组；范围表达式返回 null。 */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(text).trim())
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function format(version) {
  return version.join('.')
}

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const spec = pkg.devDependencies?.electron
if (typeof spec !== 'string') fail('package.json 缺少 devDependencies.electron')

let current = parseVersion(spec)
if (current === null) {
  // 范围写法（如 ^45.2.3）无法代表实际安装版本，退回到 node_modules。
  try {
    const installed = JSON.parse(
      await readFile(new URL('../node_modules/electron/package.json', import.meta.url), 'utf8')
    )
    current = parseVersion(installed.version)
  } catch {
    fail(`electron 不是精确版本（${spec}），且未找到已安装的 electron`)
  }
}

const major = current[0]
const tag = `${major}-x-y`

let tags
try {
  const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  tags = await response.json()
} catch (error) {
  fail(`无法读取 npm registry：${error instanceof Error ? error.message : String(error)}`)
}

/** 优先取该 major 的 dist-tag；没有时只在 latest 仍属同一 major 的情况下使用。 */
function latestForMajor(distTags, targetMajor) {
  const tagged = distTags[`${targetMajor}-x-y`]
  if (typeof tagged === 'string') return tagged
  const latest = distTags.latest
  return typeof latest === 'string' && latest.startsWith(`${targetMajor}.`) ? latest : null
}

const candidate = latestForMajor(tags, major)
const latest = typeof candidate === 'string' ? parseVersion(candidate) : null
if (latest === null || latest[0] !== major) {
  fail(`npm registry 没有 ${major}.x 的稳定版本（${tag}=${candidate ?? 'missing'}）`)
}

const date = new Date().toISOString().slice(0, 10)
console.log(`Electron 补丁检查（${date}）`)
console.log(`- 当前锁定：${format(current)}（major ${major}）`)
console.log(`- 远端最新：${format(latest)}`)

if (compare(current, latest) >= 0) {
  console.log('- 结论：已是最新补丁')
  process.exit(0)
}

console.log('- 结论：落后，需要跟进')
console.log('')
console.log('升级步骤：')
console.log(`  pnpm add -D electron@${format(latest)}`)
console.log('  pnpm electron:prepare')
console.log('  pnpm typecheck && pnpm lint && pnpm format:check && pnpm test')
console.log('  CI=true DSH_HUB_E2E_HIDDEN=1 pnpm test:e2e')
process.exit(EXIT_BEHIND)
