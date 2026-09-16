/**
 * dsh 运行时安装器（T3）—— 不 import electron（全局规则 5）。
 *
 * 设计依据：`docs/dsh-hub-desktop-design.md` §4.1 与实现计划 §6.2 ——
 * 按版本把 `@deepseek-ai/dsh` 装进隔离目录 `runtimes/dsh-<version>/`，版本间零干扰；
 * 安装中写 `installing.json` 支持断点恢复；列表来自 npm registry。
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'

/** 版本号只允许这些字符，避免拼接目录名被穿越（runtime-source 的 PATH 探测同样复用） */
export const VERSION_PATTERN = /^[0-9A-Za-z.+_-]+$/

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv }
) => Promise<CommandResult>

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise<CommandResult>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: { ...process.env, ...options.env },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 15 * 60_000
      },
      (error, stdout, stderr) => {
        // npm 非零退出也返回结果（由调用方判断），只有启动失败才 reject
        if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
          reject(error)
          return
        }
        const exitCode =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code?: number }).code ?? 1)
            : 0
        resolve({ code: exitCode, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

export interface InstalledRuntime {
  version: string
  /** runtimes/dsh-<version> */
  dir: string
  /** node <entry> —— 即 dsh 的 bin.js */
  entry: string
  /** 安装完成时间（ISO）；来自目录 mtime */
  installedAt: string
}

export interface InstallProgress {
  phase: 'resolving' | 'installing'
  version: string
  detail?: string
}

export interface RuntimeInstallerOptions {
  /** <dataRoot>/runtimes */
  runtimesDir: string
  /** npm 缓存目录（放在应用数据目录内，避免污染/受限的用户级缓存） */
  cacheDir: string
  registry?: string
  run?: CommandRunner
  onProgress?: (progress: InstallProgress) => void
}

export interface RuntimeInstaller {
  listAvailableVersions(): Promise<string[]>
  resolveDefaultVersion(): Promise<string>
  listInstalled(): Promise<InstalledRuntime[]>
  isInstalled(version: string): Promise<boolean>
  install(version: string): Promise<InstalledRuntime>
  /**
   * 原子「检查并安装」：同一版本只会安装一次 —— 并发调用（多实例同时首次启动）
   * 会在队列里串行，后来者直接复用已完成的安装结果。
   */
  ensureInstalled(version: string): Promise<InstalledRuntime>
  resolveEntry(version: string): string
  /** 安装中断标记（installing.json）是否残留 */
  hasIncompleteInstall(version: string): Promise<boolean>
}

const INSTALLING_MARKER = 'installing.json'

export function runtimeDirFor(runtimesDir: string, version: string): string {
  assertVersion(version)
  return join(runtimesDir, `dsh-${version}`)
}

export function runtimeEntryFor(runtimesDir: string, version: string): string {
  return join(runtimeDirFor(runtimesDir, version), 'node_modules', DSH_PACKAGE_NAME, 'lib', 'bin.js')
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`非法版本号：${version}`)
  }
}

export function createRuntimeInstaller(options: RuntimeInstallerOptions): RuntimeInstaller {
  const run = options.run ?? runCommand
  const registryArgs = options.registry ? ['--registry', options.registry] : []

  // 同名目录的安装/检查必须串行(双实例并发启动会撞同一 runtimes/dsh-<v> 目录)
  let installChain: Promise<unknown> = Promise.resolve()
  function enqueueSerial<T>(task: () => Promise<T>): Promise<T> {
    const next = installChain.then(task, task)
    installChain = next.catch(() => undefined)
    return next
  }

  async function npmView(args: string[]): Promise<CommandResult> {
    // 所有 npm 调用统一走应用私有 cache：用户级 ~/.npm 可能有权限问题(如 root 残留)，
    // 且避免污染用户缓存；调用本身经串行队列(见 enqueueSerial),避免并发 npm 争抢 cacache 锁
    return run(
      'npm',
      ['view', DSH_PACKAGE_NAME, ...args, '--cache', options.cacheDir, ...registryArgs],
      { env: { npm_config_cache: options.cacheDir } }
    )
  }

  /** 内部实现(不入队):供已持有队列的任务调用,避免嵌套自锁 */
  async function unsafeListAvailableVersions(): Promise<string[]> {
    const result = await npmView(['versions', '--json'])
    if (result.code !== 0) {
      throw new Error(`读取可用版本失败：${result.stderr.trim() || `exit ${result.code}`}`)
    }
    const parsed: unknown = JSON.parse(result.stdout || '[]')
    const list = Array.isArray(parsed) ? parsed : []
    return list.filter((item): item is string => typeof item === 'string').filter((v) => !v.includes('/'))
  }

  async function unsafeResolveDefaultVersion(): Promise<string> {
    const result = await npmView(['dist-tags', '--json'])
    if (result.code === 0) {
      const tags: unknown = JSON.parse(result.stdout || '{}')
      const latest =
        tags && typeof tags === 'object' ? (tags as Record<string, unknown>)['latest'] : undefined
      if (typeof latest === 'string' && VERSION_PATTERN.test(latest)) return latest
    }
    const versions = await unsafeListAvailableVersions()
    if (versions.length === 0) throw new Error('registry 中没有可用的 dsh 版本')
    return versions[versions.length - 1] as string
  }

  return {
    listAvailableVersions(): Promise<string[]> {
      return enqueueSerial(() => unsafeListAvailableVersions())
    },

    resolveDefaultVersion(): Promise<string> {
      return enqueueSerial(() => unsafeResolveDefaultVersion())
    },

    async listInstalled(): Promise<InstalledRuntime[]> {
      let names: string[]
      try {
        names = await readdir(options.runtimesDir)
      } catch {
        return []
      }
      const installed: InstalledRuntime[] = []
      for (const name of names) {
        if (!name.startsWith('dsh-')) continue
        const version = name.slice('dsh-'.length)
        if (!VERSION_PATTERN.test(version)) continue
        if (await this.hasIncompleteInstall(version)) continue
        const stats = await stat(join(options.runtimesDir, name)).catch(() => null)
        installed.push({
          version,
          dir: runtimeDirFor(options.runtimesDir, version),
          entry: runtimeEntryFor(options.runtimesDir, version),
          installedAt: (stats?.mtime ?? new Date(0)).toISOString()
        })
      }
      return installed.sort((a, b) => a.version.localeCompare(b.version))
    },

    isInstalled(version: string): Promise<boolean> {
      // 走同一串行队列:等待可能在飞的安装结束,避免误判「未安装」而重复安装
      return enqueueSerial(() => unsafeIsInstalled(version))
    },

    resolveEntry(version: string): string {
      return runtimeEntryFor(options.runtimesDir, version)
    },

    hasIncompleteInstall(version: string): Promise<boolean> {
      assertVersion(version)
      return hasIncompleteInstallMarker(version)
    },

    install(version: string): Promise<InstalledRuntime> {
      return enqueueSerial(() => doInstall(version))
    },

    ensureInstalled(version: string): Promise<InstalledRuntime> {
      return enqueueSerial(async () => {
        assertVersion(version)
        if (!(await unsafeIsInstalled(version))) return doInstall(version)
        const dir = runtimeDirFor(options.runtimesDir, version)
        const stats = await stat(dir)
        return {
          version,
          dir,
          entry: runtimeEntryFor(options.runtimesDir, version),
          installedAt: stats.mtime.toISOString()
        }
      })
    }
  }

  async function unsafeIsInstalled(version: string): Promise<boolean> {
    assertVersion(version)
    if (await hasIncompleteInstallMarker(version)) return false
    try {
      await stat(runtimeEntryFor(options.runtimesDir, version))
      return true
    } catch {
      return false
    }
  }

  async function hasIncompleteInstallMarker(version: string): Promise<boolean> {
    try {
      await stat(join(runtimeDirFor(options.runtimesDir, version), INSTALLING_MARKER))
      return true
    } catch {
      return false
    }
  }

  async function doInstall(version: string): Promise<InstalledRuntime> {
    assertVersion(version)
    const dir = runtimeDirFor(options.runtimesDir, version)
    const markerPath = join(dir, INSTALLING_MARKER)

    await mkdir(options.runtimesDir, { recursive: true })
    await mkdir(dir, { recursive: true })
    await writeFile(
      markerPath,
      JSON.stringify({ version, startedAt: new Date().toISOString(), pid: process.pid }, null, 2),
      'utf8'
    )
    options.onProgress?.({
      phase: 'installing',
      version,
      detail: `安装 ${DSH_PACKAGE_NAME}@${version}`
    })

    const result = await run(
      'npm',
      [
        'install',
        '--prefix',
        dir,
        '--no-audit',
        '--no-fund',
        '--loglevel',
        'error',
        '--cache',
        options.cacheDir,
        `${DSH_PACKAGE_NAME}@${version}`,
        ...registryArgs
      ],
      { env: { npm_config_cache: options.cacheDir } }
    )
    if (result.code !== 0) {
      // 失败时保留 installing.json：下次可识别为「未完成安装」(断点恢复依据)
      throw new Error(
        `安装 ${DSH_PACKAGE_NAME}@${version} 失败（exit ${result.code}）：${result.stderr.trim() || '无 stderr'}`
      )
    }
    const entry = runtimeEntryFor(options.runtimesDir, version)
    await stat(entry) // 入口不存在视为安装失败
    await rm(markerPath, { force: true })
    const stats = await stat(dir)
    return { version, dir, entry, installedAt: stats.mtime.toISOString() }
  }
}

/** 读取安装标记（诊断用） */
export async function readInstallingMarker(
  runtimesDir: string,
  version: string
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(runtimeDirFor(runtimesDir, version), INSTALLING_MARKER), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}