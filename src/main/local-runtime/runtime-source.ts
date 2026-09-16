/**
 * dsh 运行时来源决策(#2 用户反馈,2026-09-16)—— 不 import electron(全局规则 5)。
 *
 * 用户决策的获取优先级:「优先 hub 已装同版本 → 再探测 PATH → 都没有才下载,
 * 真要下载时需要用户确认」。本模块是其中的**纯决策与探测原语**:
 *
 * - `planRuntimeSource`:给定(固定版本 / hub 已装清单 / PATH 探测结果),产出
 *   「用 hub / 用 PATH / 需下载(需用户确认)」的计划。纯函数、依赖全注入,可穷举测试。
 * - `createPathProbe`:探测 PATH 上的 dsh(`which`/`where` → 绝对路径校验 →
 *   `dsh --version` 解析版本)。探测失败一律返回 null(尽力而为,不阻塞启动)。
 * - `compareDshVersions`:数字感知的版本比较(0.10.0 > 0.9.0;正式 > 同号 rc),
 *   用于「hub 已装清单取最新」。
 *
 * 接线(调用方)注意:PATH 来源运行时**不回写** `dshVersion` —— 未固定实例应跟随
 * 用户本机升级,而不是被钉死在探测当天的版本上(见 index.ts 状态事件的回写闸)。
 */
import { posix } from 'node:path'
import { VERSION_PATTERN } from './runtime-installer'
import type { CommandRunner } from './runtime-installer'

/** PATH 上探测到的 dsh 运行时 */
export interface PathRuntime {
  /** dsh 可执行文件的绝对路径 */
  command: string
  /** `dsh --version` 输出的版本号(已校验) */
  version: string
}

/** 运行时来源计划(kind 字段做判别) */
export type RuntimePlan =
  | {
      kind: 'hub'
      version: string
      reason: 'pinned-installed' | 'unpinned-installed'
    }
  | {
      kind: 'path'
      command: string
      version: string
      reason: 'pinned-path-match' | 'unpinned-path-any'
    }
  | {
      kind: 'download'
      /** 下载目标版本;null = 未固定,由调用方解析 registry latest */
      version: string | null
      reason: 'pinned-missing' | 'unpinned-missing'
    }

/** planRuntimeSource 的输入(全部显式注入,便于穷举测试) */
export interface PlanInput {
  /** 实例固定版本;null = 未固定(跟随最新) */
  desiredVersion: string | null
  /** hub `runtimes/` 里已装的版本清单 */
  hubInstalled: readonly string[]
  /** PATH 探测结果;null = 没探到 */
  pathRuntime: PathRuntime | null
}

/**
 * 版本比较:按 `.` 分段,先比每段的前导数字(0.10.0 > 0.9.0),
 * 数字相同再比后缀 —— 无后缀(正式)> 有 rc 后缀(0.1.5 > 0.1.5-rc.2)。
 * 非数字开头段按 0 处理再比后缀字典序。返回负数 = a < b。
 */
export function compareDshVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const segA = pa[i] ?? ''
    const segB = pb[i] ?? ''
    const numA = leadingNumber(segA)
    const numB = leadingNumber(segB)
    if (numA !== numB) return numA - numB
    const suffixA = segA.slice(String(numA).length)
    const suffixB = segB.slice(String(numB).length)
    if (suffixA !== suffixB) {
      // 正式(无后缀)> 预发布(有 rc 等后缀)
      if (suffixA === '') return 1
      if (suffixB === '') return -1
      return suffixA < suffixB ? -1 : 1
    }
  }
  return 0
}

function leadingNumber(segment: string): number {
  const match = /^[0-9]+/.exec(segment)
  return match ? Number(match[0]) : 0
}

/**
 * 来源决策(纯函数):
 * - 固定 X:hub 装了 X → hub;PATH dsh 版本恰为 X → path;否则 download X(需确认)
 * - 未固定:PATH 有 dsh → path(用户自己维护的安装,永远最新);
 *   否则 hub 已装任意版本(取最新,复用已下载)→ hub;否则 download null(需确认)
 */
export function planRuntimeSource(input: PlanInput): RuntimePlan {
  const { desiredVersion, hubInstalled, pathRuntime } = input

  if (desiredVersion !== null) {
    if (hubInstalled.includes(desiredVersion)) {
      return { kind: 'hub', version: desiredVersion, reason: 'pinned-installed' }
    }
    if (pathRuntime !== null && pathRuntime.version === desiredVersion) {
      return { kind: 'path', command: pathRuntime.command, version: desiredVersion, reason: 'pinned-path-match' }
    }
    return { kind: 'download', version: desiredVersion, reason: 'pinned-missing' }
  }

  if (pathRuntime !== null) {
    return { kind: 'path', command: pathRuntime.command, version: pathRuntime.version, reason: 'unpinned-path-any' }
  }
  if (hubInstalled.length > 0) {
    const latest = [...hubInstalled].sort(compareDshVersions).at(-1) ?? hubInstalled[0]!
    return { kind: 'hub', version: latest, reason: 'unpinned-installed' }
  }
  return { kind: 'download', version: null, reason: 'unpinned-missing' }
}

export interface PathProbe {
  /** 探测 PATH 上的 dsh;失败返回 null(尽力而为) */
  probe(): Promise<PathRuntime | null>
}

export interface PathProbeOptions {
  run?: CommandRunner
  /** 进程平台(注入便于测试 win32 分支);默认取当前进程 */
  platform?: NodeJS.Platform
}

const WHICH_TIMEOUT_MS = 15_000

/**
 * PATH 探测:`which dsh`(win32 用 `where`)→ 绝对路径校验 → `dsh --version` 解析。
 * 任何一步失败都返回 null —— 探测不到 PATH dsh 不是错误,只是回落到下一优先级。
 */
export function createPathProbe(options: PathProbeOptions = {}): PathProbe {
  const run =
    options.run ??
    ((command, args) =>
      new Promise((resolve, reject) => {
        // 内联最小执行器:探测只关心 stdout/exit code;超时远短于安装器的 15 分钟
        import('node:child_process').then(({ execFile }) => {
          execFile(
            command,
            args,
            { timeout: WHICH_TIMEOUT_MS, maxBuffer: 64 * 1024 },
            (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
              const code =
                error && typeof (error as { code?: unknown }).code === 'number'
                  ? ((error as { code?: number }).code ?? 1)
                  : error
                    ? 1
                    : 0
              if (error && code === 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(error)
                return
              }
              resolve({ code, stdout: String(stdout), stderr: String(stderr) })
            }
          )
        }).catch(reject)
      }))
  const platform = options.platform ?? process.platform

  return {
    async probe(): Promise<PathRuntime | null> {
      const which = platform === 'win32' ? 'where' : 'which'
      // which/where 自身不存在(极端环境)按「未探测到」处理
      let located: CommandResultLike
      try {
        located = await run(which, ['dsh'])
      } catch {
        return null
      }
      if (located.code !== 0) return null
      const command = firstLine(located.stdout)
      // 输出必须是绝对路径:PATH 被塞相对路径时不采用(不可靠且 spawn 行为随 cwd 漂移)
      if (command === '' || !isAbsoluteFor(platform, command)) return null

      let versioned: CommandResultLike
      try {
        versioned = await run(command, ['--version'])
      } catch {
        return null
      }
      if (versioned.code !== 0) return null
      const version = firstLine(versioned.stdout)
      if (!VERSION_PATTERN.test(version)) return null
      return { command, version }
    }
  }
}

interface CommandResultLike {
  code: number
  stdout: string
  stderr: string
}

function firstLine(stdout: string): string {
  return (stdout.split('\n')[0] ?? '').trim()
}

function isAbsoluteFor(platform: NodeJS.Platform, p: string): boolean {
  if (platform === 'win32') {
    // 盘符路径(允许大小写盘符)或 UNC 路径
    return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
  }
  return posix.isAbsolute(p)
}
