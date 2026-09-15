#!/usr/bin/env node
/**
 * 生成 `dist/SHA256SUMS.txt`(T14 发布演练)。
 *
 * 为什么需要:自动更新链路自带 sha512,但**手工下载安装包**的人没有完整性依据。
 * SHA-256 是发布物的通用校验口径,发布说明里直接引用这个文件。
 *
 * 用法:`node scripts/release/checksums.mjs [distDir]`
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const SUMS_FILE = 'SHA256SUMS.txt'
/** `*.blockmap` 是给自动更新做差分的中间产物,不属于「分发给人的产物」 */
const EXCLUDED_SUFFIXES = ['.blockmap']

export async function sha256Of(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** 收集 `dist/` 下应当出现在校验和清单里的文件(按文件名排序,保证可复现) */
export async function collectArtifacts(distDir) {
  const names = await readdir(distDir)
  const files = []
  for (const name of names) {
    if (name === SUMS_FILE) continue
    if (EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue
    const full = join(distDir, name)
    const info = await stat(full)
    if (!info.isFile()) continue
    files.push({ name, size: info.size })
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

async function main() {
  const distDir = resolve(process.argv[2] ?? 'dist')
  const files = await collectArtifacts(distDir)
  if (files.length === 0) {
    console.error(`[release] ${distDir} 下没有可校验的产物 —— 先执行 pnpm dist:mac:zip / pnpm dist:win`)
    process.exit(1)
  }
  const lines = []
  for (const file of files) {
    const digest = await sha256Of(join(distDir, file.name))
    lines.push(`${digest}  ${file.name}`)
    console.log(`[release] sha256 ${digest}  ${file.name}`)
  }
  const target = join(distDir, SUMS_FILE)
  await writeFile(target, `${lines.join('\n')}\n`, 'utf8')
  console.log(`[release] 已写出 ${target}（${files.length} 个产物）`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[release] 生成校验和失败：', error)
    process.exit(1)
  })
}
