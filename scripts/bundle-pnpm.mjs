/**
 * 把 JS 版 pnpm 复制到 build/pnpm-runtime/pnpm/，供打包时 extraResources 引用。
 *
 * dsh 的插件管理把参数转发给 pnpm（`dsh plugin … → execa('pnpm', …)`）。目标机未必装
 * pnpm，装了也可能是 pnpm v12 的「上下文感知全局 shim」——在 nvm 等按需切换 node 的
 * 环境下其完整性校验会失败（shim integrity check failed）。随包分发一份 pnpm v10（最后的
 * 纯 JS 版，`bin/pnpm.cjs` 可被任意 Node 直接执行、不是全局 shim），由主进程经 PATH 前置
 * 交给 dsh 使用，使插件管理彻底与系统 pnpm 解耦。
 *
 * 不把 pnpm 加入依赖树：用 `npm pack` 下载指定版本的发布 tarball（已是自包含真实文件，
 * 无 pnpm 符号链接问题），解压后置于 build/pnpm-runtime/pnpm。版本固定以保证可复现。
 *
 * 目标刻意多套一层目录（build/pnpm-runtime/pnpm）：electron-builder 会过滤掉 extraResources
 * 复制源**根部**的 `node_modules`（见 app-builder-lib 的 filter.js），而 pnpm 的
 * `dist/node_modules` 是子目录，`from: build/pnpm-runtime, to: pnpm-runtime` 可完整保留。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 固定的 pnpm 版本：v10 线最后的纯 JS 实现（v11 起为 Rust 原生二进制 + 全局 shim）。 */
const PNPM_VERSION = '10.34.6'

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const stageRoot = join(projectDir, 'build', 'pnpm-runtime')
const target = join(stageRoot, 'pnpm')

const work = mkdtempSync(join(tmpdir(), 'bundle-pnpm-'))
try {
  // npm pack 把 pnpm-<ver>.tgz 下到 work/；--pack-destination 控制落点，避免污染仓库。
  execFileSync('npm', ['pack', `pnpm@${PNPM_VERSION}`, '--pack-destination', work], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
  const tgz = readdirSync(work).find((name) => name.endsWith('.tgz'))
  if (tgz === undefined) {
    console.error(`[bundle-pnpm] npm pack 未产出 tarball（pnpm@${PNPM_VERSION}）`)
    process.exit(1)
  }
  // tar 解出 package/ 目录（发布 tarball 的固定根）。
  execFileSync('tar', ['xzf', join(work, tgz), '-C', work], { stdio: 'inherit' })
  const extracted = join(work, 'package')
  if (!existsSync(join(extracted, 'bin', 'pnpm.cjs'))) {
    console.error(`[bundle-pnpm] 解压后未找到入口：${extracted}/bin/pnpm.cjs`)
    process.exit(1)
  }
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(extracted, target, { recursive: true })
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (!existsSync(join(target, 'bin', 'pnpm.cjs')) || !existsSync(join(target, 'dist', 'pnpm.cjs'))) {
  console.error(`[bundle-pnpm] 复制后缺少 pnpm 入口或 dist，产物不完整`)
  process.exit(1)
}

console.log(`[bundle-pnpm] 已复制 pnpm@${PNPM_VERSION} → ${target}`)
