/**
 *
 * 按版本把 `@deepseek-ai/dsh` 装进隔离目录 `runtimes/dsh-<version>/`，版本间零干扰；
 * 安装中写 `installing.json` 支持断点恢复；列表来自 npm registry。
 */
import { execFile, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 一次可执行的 npm 调用方式。
 *
 * Windows 不返回 .cmd 路径：其一，shim 损坏时报 "shim integrity check failed"；
 * 其二，Node ≥ 20.12 出于命令注入防护（CVE-2024-27980）禁止 spawn 直接执行
 * .cmd/.bat。因此 Windows 统一用 node.exe 直跑 npm-cli.js。
 */
export interface NpmInvocation {
  /** 直接可执行的程序：Unix 为 npm 入口脚本，Windows 为 node.exe */
  command: string
  /** 紧随程序的固定参数；Windows 下为 npm-cli.js 路径，其余为空 */
  prefixArgs: string[]
}

function defaultExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function resolveNpmCliJs(): string | null {
  try {
    // npm-cli.js 是 npm 的入口脚本
    const resolved = require.resolve('npm/bin/npm-cli.js')
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null
  } catch {
    // 找不到 npm 模块：走系统路径探测
    return null
  }
}

/** Windows：PATH 各目录里 node.exe 所在目录（供与 npm-cli.js 组合） */
function findWindowsNodeDir(exists: (path: string) => boolean): string | null {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir === '') continue
    if (exists(join(dir, 'node.exe'))) return dir
  }
  return null
}

/** Windows：node.exe 可能所在的目录，PATH 优先，常见安装位置兜底 */
function windowsNodeDirs(): string[] {
  const dirs = (process.env.PATH ?? '')
    .split(';')
    .filter((dir) => dir !== '')
  return [
    ...dirs,
    join(process.env['ProgramFiles'] || 'C:\\Program Files', 'nodejs'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs')
  ]
}

/**
 * 解析可用的 npm 调用方式，按优先级尝试：
 * 1. node_modules 里的 npm-cli.js（开发环境 / npm 作为依赖存在时）
 * 2. PATH 与常见安装位置中 node.exe + 自带 npm-cli.js 的组合（仅 Windows）
 * 3. 系统 PATH 上的 npm（which 定位，仅 Unix）
 * 4. 常见全局安装位置（GUI 启动时 PATH 可能残缺）
 * 返回 null 表示所有方式均不可用。
 */
export async function resolveNpmInvocation(
  run: CommandRunner = runCommand,
  exists: (path: string) => boolean = defaultExists
): Promise<NpmInvocation | null> {
  const npmCliJs = resolveNpmCliJs()

  if (process.platform === 'win32') {
    // ① 开发环境解析到的 npm-cli.js 配 PATH 上的 node.exe
    if (npmCliJs) {
      const nodeDir = findWindowsNodeDir(exists)
      if (nodeDir) return { command: join(nodeDir, 'node.exe'), prefixArgs: [npmCliJs] }
    }
    // ② node.exe 与其自带 npm-cli.js 同在的目录
    for (const dir of windowsNodeDirs()) {
      const nodeExe = join(dir, 'node.exe')
      const bundledCli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (exists(nodeExe) && exists(bundledCli)) return { command: nodeExe, prefixArgs: [bundledCli] }
    }
    return null
  }

  // Unix：npm 入口脚本带 shebang，可直接执行
  if (npmCliJs) return { command: npmCliJs, prefixArgs: [] }

  // PATH 上与 node 同目录的 npm
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const npmInSameDir = join(dir, 'npm')
    if (exists(join(dir, 'node')) && exists(npmInSameDir)) return { command: npmInSameDir, prefixArgs: [] }
  }

  // 系统 PATH 上的 which
  try {
    const result = await run('which', ['npm'])
    if (result.code === 0) {
      const first = result.stdout.split('\n')[0]?.trim()
      if (first && first.length > 0) return { command: first, prefixArgs: [] }
    }
  } catch {
    // which 不存在：继续尝试候选路径
  }

  // 常见全局安装位置（GUI 启动时 PATH 可能残缺）
  for (const candidate of [
    '/usr/local/bin/npm',
    '/usr/bin/npm',
    join(process.env['HOME'] || '', '.nvm', 'current', 'bin', 'npm'),
    join(process.env['HOME'] || '', '.local', 'bin', 'npm'),
    join(process.env['HOME'] || '', '.volta', 'bin', 'npm')
  ]) {
    if (exists(candidate)) return { command: candidate, prefixArgs: [] }
  }

  return null
}

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

/** 流式运行 npm：stderr 逐行回调供进度解析；与 runCommand 一样只有启动失败才 reject。 */
export type NpmRunner = (
  npm: NpmInvocation,
  args: string[],
  options: { env: NodeJS.ProcessEnv; onStderrLine?: (line: string) => void }
) => Promise<CommandResult>

export const spawnNpm: NpmRunner = (npm, args, options) =>
  new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(npm.command, [...npm.prefixArgs, ...args], {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let pendingLine = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk)
      stderr += text
      const lines = (pendingLine + text).split(/\r?\n/)
      pendingLine = lines.pop() ?? ''
      for (const line of lines) options.onStderrLine?.(line)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (pendingLine !== '') options.onStderrLine?.(pendingLine)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })

/**
 * 从 npm `--loglevel http` 的 stderr 行提取下载项相对路径。
 * 完成行形如 `npm http fetch GET 200 <url> <耗时>`；请求行与非 fetch 行返回 null。
 */
export function npmFetchPath(line: string): string | null {
  const match = /^npm http fetch GET \d+ (\S+)/.exec(line)
  const url = match?.[1]
  if (!url) return null
  return url.replace(/https?:\/\/[^/]+\//, '').split('?')[0] || null
}

/** 取文本最后 max 行——npm 失败的结论性输出在日志末尾。 */
function tailLines(text: string, max: number): string {
  const lines = text.trim().split('\n')
  return lines.slice(-max).join('\n')
}

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
  /** 0–100 整数百分比；未知阶段为 undefined。 */
  percent?: number
}

export interface RuntimeInstallerOptions {
  /** <dataRoot>/runtimes */
  runtimesDir: string
  /** npm 缓存目录（放在应用数据目录内，避免污染/受限的用户级缓存） */
  cacheDir: string
  registry?: string
  /** 动态获取 registry（每次安装时读取最新设置）；优先级高于静态 registry。 */
  getRegistry?: () => string | undefined
  run?: CommandRunner
  /** 流式运行 npm（注入便于测试）；默认 spawnNpm。 */
  runNpm?: NpmRunner
  /** 文件存在性检查（注入便于测试）；默认使用 fs.statSync */
  exists?: (path: string) => boolean
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
  ensureInstalled(version: string, onProgress?: (progress: InstallProgress) => void): Promise<InstalledRuntime>
  resolveEntry(version: string): string
  /** 安装中断标记（installing.json）是否残留 */
  hasIncompleteInstall(version: string): Promise<boolean>
  /** npm registry 上的最新稳定版本（listAvailableVersions 取末项）。 */
  resolveLatestVersion(): Promise<string>
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
  const runNpm = options.runNpm ?? spawnNpm

  /** 解析当前生效的 registry：动态回调优先，其次静态配置。 */
  function currentRegistry(): string | undefined {
    return options.getRegistry?.() ?? options.registry
  }
  function registryArgs(): string[] {
    const r = currentRegistry()
    return r ? ['--registry', r] : []
  }

  // 同名目录的安装/检查必须串行(双实例并发启动会撞同一 runtimes/dsh-<v> 目录)
  let installChain: Promise<unknown> = Promise.resolve()
  function enqueueSerial<T>(task: () => Promise<T>): Promise<T> {
    const next = installChain.then(task, task)
    installChain = next.catch(() => undefined)
    return next
  }

  // 缓存 npm 调用方式解析结果(只解析一次,避免重复探测)
  let resolvedNpm: NpmInvocation | null = null
  let npmResolved = false

  async function getNpmInvocation(): Promise<NpmInvocation> {
    if (!npmResolved) {
      resolvedNpm = await resolveNpmInvocation(run, options.exists)
      npmResolved = true
    }
    if (resolvedNpm === null) {
      throw new Error('npm 不可用：系统 PATH 和常见安装位置均未找到 npm')
    }
    return resolvedNpm
  }

  async function npmView(args: string[]): Promise<CommandResult> {
    // 所有 npm 调用统一走应用私有 cache：用户级 ~/.npm 可能有权限问题(如 root 残留)，
    // 且避免污染用户缓存；调用本身经串行队列(见 enqueueSerial),避免并发 npm 争抢 cacache 锁
    const npm = await getNpmInvocation()
    return run(
      npm.command,
      [...npm.prefixArgs, 'view', DSH_PACKAGE_NAME, ...args, '--cache', options.cacheDir, ...registryArgs()],
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

    resolveLatestVersion(): Promise<string> {
      return enqueueSerial(async () => {
        const versions = await unsafeListAvailableVersions()
        if (versions.length === 0) throw new Error('registry 中没有可用的 dsh 版本')
        return versions[versions.length - 1] as string
      })
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

    ensureInstalled(version: string, onProgress?: (progress: InstallProgress) => void): Promise<InstalledRuntime> {
      return enqueueSerial(async () => {
        assertVersion(version)
        if (!(await unsafeIsInstalled(version))) return doInstall(version, onProgress)
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

  async function doInstall(version: string, onProgress?: (progress: InstallProgress) => void): Promise<InstalledRuntime> {
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
    onProgress?.({
      phase: 'installing',
      version,
      detail: `安装 ${DSH_PACKAGE_NAME}@${version}`
    })

    const npm = await getNpmInvocation()
    const installArgs = [
      'install',
      '--prefix',
      dir,
      '--no-audit',
      '--no-fund',
      '--loglevel',
      'http',
      '--cache',
      options.cacheDir,
      `${DSH_PACKAGE_NAME}@${version}`,
      ...registryArgs()
    ]

    let result: CommandResult
    if (onProgress) {
      // 进度分支：stderr 逐行解析 npm 的 fetch 完成日志驱动进度回调
      let fetchCount = 0
      let lastDetail = ''
      result = await runNpm(npm, installArgs, {
        env: { ...process.env, npm_config_cache: options.cacheDir },
        onStderrLine: (line) => {
          const path = npmFetchPath(line)
          if (!path) return
          fetchCount += 1
          const detail = `下载依赖 (${fetchCount})：${path}`
          if (detail !== lastDetail) {
            lastDetail = detail
            // 百分比上限 90%，校验与收尾留给 95/100
            onProgress({ phase: 'installing', version, detail, percent: Math.min(90, 10 + fetchCount * 3) })
          }
        }
      })
    } else {
      // 无进度回调走 execFile 汇总（便于测试 mock）
      result = await run(npm.command, [...npm.prefixArgs, ...installArgs], {
        env: { npm_config_cache: options.cacheDir }
      })
    }

    if (result.code !== 0) {
      // http 级日志的 stderr 含全部 fetch 行，只保留尾部的结论性输出
      throw new Error(
        `安装 ${DSH_PACKAGE_NAME}@${version} 失败（exit ${result.code}）：${tailLines(result.stderr, 20) || '无 stderr'}`
      )
    }
    onProgress?.({ phase: 'installing', version, detail: '校验安装结果', percent: 95 })
    const entry = runtimeEntryFor(options.runtimesDir, version)
    await stat(entry)
    await rm(markerPath, { force: true })
    onProgress?.({ phase: 'installing', version, percent: 100 })
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