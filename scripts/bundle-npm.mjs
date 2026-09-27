/**
 * 把 npm 复制到 build/npm-runtime/npm/，供打包时 extraResources 引用。
 *
 * pnpm 把 npm 及其依赖装成符号链接（node_modules/npm → .pnpm/npm@x/node_modules/npm，
 * 其 node_modules/* 又各自指向 .pnpm 里的真实目录）。electron-builder 复制 extraResources
 * 时不会递归解引用这些嵌套链接，导致包内 npm/node_modules 为空、npm 一运行即
 * `Cannot find module 'graceful-fs'`。这里用解引用复制得到一份自包含的 npm。
 *
 * 目标刻意多套一层目录（build/npm-runtime/npm）：electron-builder 会过滤掉 extraResources
 * 复制源**根部**的 `node_modules`（见 app-builder-lib 的 filter.js），但保留子目录下的
 * `npm/node_modules`。因此 electron-builder.yml 用 `from: build/npm-runtime, to: .`，
 * 复制出的 node_modules 相对路径为 `npm/node_modules`，不落在被过滤的根部。
 */
import { cpSync, mkdirSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = realpathSync(join(projectDir, 'node_modules', 'npm'))
const stageRoot = join(projectDir, 'build', 'npm-runtime')
const target = join(stageRoot, 'npm')

if (!existsSync(join(source, 'bin', 'npm-cli.js'))) {
  console.error(`[bundle-npm] 未找到 npm 入口：${source}/bin/npm-cli.js（先安装依赖）`)
  process.exit(1)
}

rmSync(stageRoot, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
// dereference：把符号链接复制成真实文件，得到自包含的 npm 副本
cpSync(source, target, { recursive: true, dereference: true })

if (!existsSync(join(target, 'node_modules', 'graceful-fs'))) {
  console.error(`[bundle-npm] 复制后缺少依赖（node_modules/graceful-fs），npm 无法运行`)
  process.exit(1)
}

console.log(`[bundle-npm] 已复制 npm → ${target}`)
