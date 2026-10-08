import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 随包分发的 JS 版 pnpm 启动器物化。
 *
 * dsh 的插件管理把参数转发给 `pnpm`（内部 `execa('pnpm', …)`），主进程无法改写这个调用，
 * 只能通过 PATH 决定它解析到哪一个 `pnpm`。这里在一个可写目录里生成一个 `pnpm` 启动器
 * （Windows 为 `pnpm.cmd`，POSIX 为可执行 `pnpm`），内容是用 Node 直接跑随包分发的
 * `bin/pnpm.cjs`；主进程把该目录前置到 dsh 子进程的 PATH，使 hub 的 `dsh plugin` CLI 调用
 * 与 dsh-web 内部的 pnpm 调用都命中这一份自带 pnpm，彻底不依赖系统 pnpm。
 *
 * 启动器固定设 `npm_config_manage_package_manager_versions=false`：阻止自带 pnpm 因项目
 * `packageManager` 字段而改用其它（可能是 Rust 原生 + 全局 shim 的）pnpm 版本，否则会把
 * 规避掉的 shim 问题重新引回来。
 */
export interface PnpmLauncherSpec {
  /** 物化启动器的可写目录（主进程传 `<userData>/pnpm-bin`）。 */
  binDir: string
  /** 随包分发的 pnpm 入口 `bin/pnpm.cjs` 绝对路径。 */
  pnpmCliJs: string
  /** 运行 pnpm.cjs 的 Node 命令；缺省裸 `node`（从继承的 PATH 解析，dsh 环境已前置 node 目录）。 */
  nodeCommand?: string
}

/**
 * 生成 pnpm 启动器脚本并返回其所在目录（供调用方前置到 PATH）。
 * 幂等：每次启动覆盖写入，内容只依赖传入的绝对路径。
 */
export function materializePnpmLauncher(spec: PnpmLauncherSpec): string {
  const node = spec.nodeCommand ?? 'node'
  mkdirSync(spec.binDir, { recursive: true })
  if (process.platform === 'win32') {
    // %* 透传全部参数；路径用双引号包裹容忍空格。
    const cmd = [
      '@echo off',
      'set "npm_config_manage_package_manager_versions=false"',
      `"${node}" "${spec.pnpmCliJs}" %*`,
      ''
    ].join('\r\n')
    writeFileSync(join(spec.binDir, 'pnpm.cmd'), cmd)
  } else {
    const sh = [
      '#!/bin/sh',
      'export npm_config_manage_package_manager_versions=false',
      `exec "${node}" "${spec.pnpmCliJs}" "$@"`,
      ''
    ].join('\n')
    const file = join(spec.binDir, 'pnpm')
    writeFileSync(file, sh)
    chmodSync(file, 0o755)
  }
  return spec.binDir
}

/**
 * 把随包 pnpm 启动器目录并入子进程 PATH。
 *
 * 平台差异（关键）：
 * - Windows：系统 pnpm 多为损坏的全局 shim（nvm 下 `shim integrity check failed`），
 *   自带 pnpm 必须**前置**胜出；
 * - 其余平台：系统 pnpm 正常，且与用户既有 profile 的 store 大版本匹配（例如 pnpm 12 建的
 *   profile 用自带的 pnpm 10 操作会 `ERR_PNPM_UNEXPECTED_STORE`），故自带 pnpm 仅作**后置**兜底，
 *   系统 pnpm 优先。
 *
 * pnpmBinDir 为空时原样返回 basePath。
 */
export function withBundledPnpmPath(
  basePath: string,
  pnpmBinDir: string | undefined,
  platform: NodeJS.Platform = process.platform
): string {
  if (!pnpmBinDir) return basePath
  const delimiter = platform === 'win32' ? ';' : ':'
  return platform === 'win32'
    ? `${pnpmBinDir}${delimiter}${basePath}`
    : `${basePath}${delimiter}${pnpmBinDir}`
}
