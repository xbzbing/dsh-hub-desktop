/**
 * 本机实例运行时：启动、接管与停止本地 dsh 进程，健康探测就绪，以及 dsh 版本升级。
 * 不 import Electron，状态只经 `onStatus` 向外发布，因此可脱离 Electron 单独测试。
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type {
  DshVersionProgressEvent,
  InstanceStatusEvent,
  LocalInstance
} from '@shared/contracts'
import { redactLine } from '@shared/redact'
import { DEFAULT_PORT_RANGE_END, findFreePort } from './port-allocator'
import type { PortProbe } from './port-allocator'
import type { InstallProgress, RuntimeInstaller } from './runtime-installer'
import { InstanceStoreError, type InstanceStore } from '../registry/instance-store'
import { followsSystemDsh, isExternalRuntime, resolveSystemDshUsage } from './dsh-source-policy'
import { resolveCmdShim } from './cmd-shim'
import { planRuntimeSource, type PathProbe } from './runtime-source'
import { searchNodeDirs } from './node-dirs'
import { mergeLoginPath, resolveLoginPathOnce } from './login-path'
import { mergeShellEnv, resolveShellEnvOnce } from './shell-env'
import { httpHealthProbe, retryProbe, type HealthProbe } from '../transport/probe'
import { createStatusBus } from '../transport/status-bus'

export type { HealthProbe } // 保持既有导出；类型定义位于 transport/probe.ts。

/**
 * 本机 dsh web 的默认端口。与 dsh 自身默认端口一致：用户对 3080 有既有预期，
 * 工作区地址 `127.0.0.1:3080` 可直接访问；被占用时仍向上递增。
 *
 * 刻意不复用 `DEFAULT_PORT_RANGE_START`（30000）：该常量与 SSH 隧道共用，改它会连带改变隧道端口。
 */
export const DEFAULT_LOCAL_PORT = 3080

/** dsh 就绪输出：`dsh web: http://127.0.0.1:52300/?token=...` */
const READY_PATTERN = /dsh\s+web:\s+(https?:\/\/\S+)/i

/** 诊断用的日志环形缓冲行数 */
const LOG_BUFFER_LINES = 80

/** 未以换行结尾的残片上限:异常的超长单行只保留尾部,防止无界增长 */
const LOG_BUFFER_MAX = 64 * 1024

export interface SpawnedProcess {
  pid?: number | undefined
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface SpawnInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  detached: boolean
}

export type SpawnLike = (invocation: SpawnInvocation) => SpawnedProcess

export interface LocalRuntimeOptions {
  installer: RuntimeInstaller
  dataRoot: string
  /** 实例注册表；升级编排完成后回写 dshVersion。 */
  store: Pick<InstanceStore, 'update'>
  /** 缺省用 Electron 自带 Node（ELECTRON_RUN_AS_NODE）执行 dsh 入口 */
  nodeInvocation?: { command: string; args: string[]; env: NodeJS.ProcessEnv }
  spawnImpl?: SpawnLike
  probe?: HealthProbe
  /** 端口可绑定探测（注入以便测试端口分配时序；缺省用真实 bind 探测） */
  portProbe?: PortProbe
  profile?: string
  /** 用户主目录来源；仅用来生成固定 ~/.dsh，不接受 renderer 指定路径。 */
  homeDir?: () => string
  readyTimeoutMs?: number
  stopGraceMs?: number
  /** stopAll 等待启动队列排空的上限；超时放弃等待，退出不被卡死的安装拖住。 */
  stopAllDrainMs?: number
  healthTimeoutMs?: number
  healthProbeRetries?: number
  healthProbeRetryMs?: number
  now?: () => number
  /**
   * 探测用户本机 PATH 上的 dsh；缺省不探测，来源决策退化为「hub → 下载」两级。
   */
  pathProbe?: PathProbe
  /**
   * 为本机（`path` 来源）启动器解析一个真实 node 可执行文件；缺省按「同目录 → PATH」探测。
   * 注入以便测试固定该解析结果（默认实现要读真实文件系统）。
   */
  resolveNode?: (scriptPath: string) => string | null
  /**
   * 登录环境 PATH 解析（登录 shell / Windows 注册表）；null=不可用时回退继承 PATH。
   * 缺省用进程内缓存的真实解析；注入以便测试。
   */
  loginPath?: () => Promise<string | null>
  /**
   * 当前用户登录 shell 的完整环境解析（含 .zshrc/.bashrc 的 export）；null=不可用。
   * 缺省用进程内缓存的真实解析；注入以便测试。
   */
  shellEnv?: () => Promise<Map<string, string> | null>
  /**
   * 是否把登录 shell 完整环境合并进本机实例；false 时仅合并 PATH（回退旧行为）。
   * 缺省 true；由设置项 inheritShellEnv 决定，读取函数注入以便运行中改设置即时生效。
   */
  inheritShellEnv?: () => boolean
  /**
   * 下载 dsh 前的用户确认口，返回 true 才继续下载；缺省视为拒绝。
   * 生产装配必须注入，测试/受限环境注入 stub。
   */
  confirmDownload?: (version: string) => Promise<boolean>
  /**
   * 公共空间实例升级系统默认 dsh 前的二次确认：该升级全局生效。
   * 返回 false = 用户拒绝，本次升级不产生任何进度、不改任何状态。缺省视为拒绝。
   */
  confirmSystemUpgrade?: (latest: string, current: string) => Promise<boolean>
}

export interface LocalRuntimeManager {
  onStatus(listener: (event: InstanceStatusEvent) => void): () => void
  /** 订阅 dsh 版本升级进度；返回取消订阅函数。 */
  onUpgradeProgress(listener: (event: DshVersionProgressEvent) => void): () => void
  /**
   * 升级到 registry 最新稳定版：解析版本 →（运行中先停）→ 安装 → 回写注册表 →（升级前在运行则重启）。
   * 公共空间且运行系统默认 dsh 的实例例外：先二次确认，确认后原位升级系统默认 dsh。
   * 调用立即返回并后台执行，进展经 onUpgradeProgress 回推；
   * 失败以 phase='error' 结束：隔离目录保留旧版，升级前在运行的实例停在停止态。
   */
  upgradeInstance(instance: LocalInstance): Promise<void>
  /** 面向主进程的私有工作区 URL；本地 BrowserAuth token 不得出现在状态事件中。 */
  urlOf(id: string): string | null
  statusOf(id: string): InstanceStatusEvent | null
  runningIds(): string[]
  start(instance: LocalInstance): Promise<void>
  stop(id: string): Promise<void>
  stopAll(): Promise<void>
  /**
   * 接管后 statusOf 返回 running + 外部 URL,「打开视图」直接可用;
   * stop() 只断开接管,**绝不终止**用户自己的进程。
   */
  adopt(instance: LocalInstance, external: AdoptTarget): Promise<void>
}

/** 接管目标(来自 external-dsh 的只读探测;端口必须已确定) */
export interface AdoptTarget {
  pid: number
  port: number
  /** `--patch <file>` 取值(dush 形态);仅用于展示 */
  patch: string | null
  /** 已验证的完整访问 URL；外部 dsh 开启 browser-auth 时包含用户提供的 token。 */
  url?: string
}

interface Entry {
  /** hub spawn 的子进程;接管外部实例时为 null(进程归用户所有) */
  child: SpawnedProcess | null
  url: string | null
  port: number | null
  version: string
  /** 本次启动的实际命令行(命令+参数),经状态事件展示;外部接管条目没有 hub 构造的命令行 */
  command?: string
  /** #2:运行时来源(hub=隔离目录 / path=用户本机 PATH / external=接管外部进程) */
  runtimeSource: 'hub' | 'path' | 'external'
  home: string
  log: string[]
  /** 未以换行结尾的残片：跨 chunk 的就绪行靠它拼接，否则会漏匹配就绪行 */
  buffer: string
  ready: boolean
  stopping: boolean
  timer: NodeJS.Timeout | null
  /** 队列放行钩子:就绪 / 退出 / 出错 / 超时 任一发生时调用(TOCTOU 防线) */
  settleSpawn?: () => void
  /** 外部接管的 pid(仅展示与诊断;停止时不 kill) */
  externalPid?: number
}

/** 串行启动任务的结果：spawned=正常拉起；cancelled=排队期间被取消；duplicate=已被前一个任务拉起 */
type StartOutcome = 'spawned' | 'cancelled' | 'duplicate'

/** 启动来源解析结果：执行入口、显示用版本、来源标记与注入 wrapper 的 dsh。 */
interface LaunchPlan {
  version: string
  runtimeSource: 'hub' | 'path'
  scriptPath: string
  /** 注入给 dush/duush 的 dsh 可执行文件；null = 不注入，由 wrapper 按 PATH 解析。 */
  dshBin: string | null
  /** 非默认启动器名（dush/duush 等）；null = 默认 dsh 启动器。 */
  customLauncherName: string | null
}

const defaultSpawn: SpawnLike = ({ command, args, env, cwd, detached }) =>
  spawn(command, args, {
    env,
    cwd,
    detached,
    stdio: ['ignore', 'pipe', 'pipe']
  })

/**
 * 启动命令展示串:命令与参数原样拼接,含空白或引号的片段加双引号,
 * 供状态事件与详情页展示、复制到终端复现。
 */
function formatCommandLine(invocation: Pick<SpawnInvocation, 'command' | 'args'>): string {
  return [invocation.command, ...invocation.args]
    .map((part) => (part !== '' && !/[\s"]/.test(part) ? part : `"${part.replace(/"/g, '\\"')}"`))
    .join(' ')
}

function defaultNodeInvocation(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  // Electron 主进程的 process.execPath 是 Electron 本体：以 ELECTRON_RUN_AS_NODE 退化为纯 Node 执行 dsh。
  // `--expose-internals` 是 dsh web profile 的硬性要求（cordis-plugin-hmr 需要），缺失时就绪后即崩

  return { command: process.execPath, args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/**
 * 解析子进程的基础环境（不含 node 目录前置与 DSH_HOME，那两步由调用方叠加）。
 *
 * 默认合并当前用户登录 shell 的完整环境（含 .zshrc/.bashrc 的 export，受保护键除外）；
 * 关闭开关、非 zsh/bash 或解析失败/超时时，回退到仅合并登录 PATH。与用户终端解析结果一致。
 */
async function resolveBaseEnv(deps: {
  inherit: boolean
  shellEnv: () => Promise<Map<string, string> | null>
  loginPath: () => Promise<string | null>
}): Promise<NodeJS.ProcessEnv> {
  const shellEnvMap = deps.inherit ? await deps.shellEnv().catch(() => null) : null
  if (shellEnvMap !== null) {
    return mergeShellEnv(process.env, shellEnvMap, process.platform)
  }
  const loginEnvPath = await deps.loginPath().catch(() => null)
  return {
    ...process.env,
    PATH: mergeLoginPath(process.env.PATH ?? '', loginEnvPath, process.platform)
  }
}

/**
 * 解析一个真实 node 可执行文件，供 hub 与本机启动器来源执行 dsh/dush/duush。
 *
 * dsh 的原生插件按运行时指纹校验：不在白名单的 Electron 版本启动即以 code=1 退出，
 * 因此**能用真实 node 时一律用真实 node**。查找顺序：脚本同目录（npm/pnpm 全局常放在一起）
 * → 常见安装落点（nvm/homebrew/pnpm 等；GUI 启动时进程 PATH 往往缺 node 目录）→ PATH。
 */
function resolveNodeFor(scriptPath: string, home: string): string | null {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const sameDir = join(dirname(scriptPath), nodeName)
  if (existsSync(sameDir)) return sameDir
  const listDir = (dir: string): string[] => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const dirs = [
    ...searchNodeDirs(home, listDir),
    ...(process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')
  ]
  for (const dir of [...new Set(dirs)]) {
    const candidate = join(dir, nodeName)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function createLocalRuntime(options: LocalRuntimeOptions): LocalRuntimeManager {
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  const probe = options.probe ?? httpHealthProbe
  const nodeInvocation = options.nodeInvocation ?? defaultNodeInvocation()
  const profile = options.profile ?? 'web'
  const homeDir = options.homeDir ?? homedir
  const resolveNode = options.resolveNode ?? ((scriptPath: string) => resolveNodeFor(scriptPath, homeDir()))
  const loginPath = options.loginPath ?? resolveLoginPathOnce
  const shellEnv = options.shellEnv ?? resolveShellEnvOnce
  const inheritShellEnv = options.inheritShellEnv ?? ((): boolean => true)
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000
  const stopGraceMs = options.stopGraceMs ?? 3_000
  const stopAllDrainMs = options.stopAllDrainMs ?? 10_000
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  // 重试次数默认 5 次；HTTP 端点为 3 次，差异说明见 probe.ts 的 retryProbe。
  const healthProbeRetries = options.healthProbeRetries ?? 5
  const healthProbeRetryMs = options.healthProbeRetryMs ?? 500
  const portProbe = options.portProbe
  const now = options.now ?? (() => Date.now())

  const entries = new Map<string, Entry>()
  const upgradeListeners = new Set<(event: DshVersionProgressEvent) => void>()
  /** 正在升级的实例；升级结束（含失败）即释放。 */
  const upgradingIds = new Set<string>()
  /** 启动阶段串行队列：同一时刻只让一个实例走完「安装 → 分配端口 → spawn → 就绪」 */
  let startChain: Promise<unknown> = Promise.resolve()
  /**
   * Generation-based cancellation: each start() call captures a generation number;
   * stop() records the current generation as the cancellation point.
   * A queued task is cancelled only if cancelGeneration >= its own generation,
   * so a new start after stop correctly proceeds while old queued starts stay cancelled.
   */
  const cancelGeneration = new Map<string, number>()
  const instanceGeneration = new Map<string, number>()
  /** 已进入启动流程的任务计数；退出时必须连同已排队任务一并取消。 */
  const pendingStartCounts = new Map<string, number>()

  function decrementPendingStart(id: string): void {
    const next = (pendingStartCounts.get(id) ?? 1) - 1
    if (next <= 0) pendingStartCounts.delete(id)
    else pendingStartCounts.set(id, next)
  }

  function enqueueStart<T>(task: () => Promise<T>): Promise<T> {
    const next = startChain.then(task, task)
    startChain = next.catch(() => undefined)
    return next
  }

  const bus = createStatusBus(now, 'local-runtime')
  const { emit, onStatus, statusOf } = bus

  function emitUpgrade(event: DshVersionProgressEvent): void {
    for (const listener of upgradeListeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[local-runtime] 升级进度监听器抛错：', error)
      }
    }
  }

  function pushLog(entry: Entry, chunk: unknown): string[] {
    entry.buffer += String(chunk)
    // 无换行残片上限(超长单行异常输出),只保留尾部防无界增长
    if (entry.buffer.length > LOG_BUFFER_MAX) entry.buffer = entry.buffer.slice(-LOG_BUFFER_MAX)
    const lines: string[] = []
    let newlineIndex: number
    while ((newlineIndex = entry.buffer.indexOf('\n')) !== -1) {
      const line = entry.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      entry.buffer = entry.buffer.slice(newlineIndex + 1)
      if (line.trim() !== '') lines.push(line)
    }
    if (lines.length > 0) {
      entry.log.push(...lines)
      if (entry.log.length > LOG_BUFFER_LINES) entry.log.splice(0, entry.log.length - LOG_BUFFER_LINES)
    }
    return lines
  }

  function logTail(entry: Entry, lines = 6): string {
    return entry.log.slice(-lines).join(' / ').split(' / ').map(redactLine).join(' / ')
  }

  function killTree(entry: Entry, signal: NodeJS.Signals): void {
    // 外部接管的条目没有子进程(hub 没 spawn 过):绝不对它做任何 kill
    const child = entry.child
    if (!child) return
    const pid = child.pid
    if (pid === undefined) return
    try {
      // detached 启动 → 子进程自成进程组，负 pid 杀整组（包装 shell + 其全部后代）
      process.kill(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* 已退出 */
      }
    }
  }

  async function waitForExit(entry: Entry, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (exited: boolean): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        resolve(exited)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref?.()
      // 外部接管条目没有子进程:没什么可等的,视作「已退出」
      if (!entry.child) {
        finish(true)
        return
      }
      entry.child.on('exit', () => finish(true))
    })
  }

  async function handleReady(id: string, entry: Entry, url: string): Promise<void> {
    const failReady = (error: unknown): void => {
      if (entry.stopping || entries.get(id) !== entry) return
      emit(id, 'error', {
        detail: error instanceof Error ? `解析就绪地址失败：${error.message}` : '解析就绪地址失败'
      })
      entry.stopping = true
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      killTree(entry, 'SIGKILL')
      entries.delete(id)
      entry.settleSpawn?.()
    }
    try {
    // 在途续体身份守卫:探测/重试期间本条目的进程可能已退出(退出处理器会删条目并立即
    // 放行队列,同 id 的第二次 start 随即拉起新进程)。陈旧续体不得再发布 running、
    // 也不得在失败终局里 `entries.delete(id)` 误删新条目 —— 否则活进程沦为无主,
    // 下次 start 又 spawn 一个,两个 dsh 共享同一 DSH_HOME。
    const stale = (): boolean => entry.stopping || entries.get(id) !== entry
    const healthy = await retryProbe({
      url,
      probe,
      retries: healthProbeRetries,
      retryMs: healthProbeRetryMs,
      timeoutMs: healthTimeoutMs,
      shouldAbort: stale
    })
    if (healthy === null) return
    if (!healthy) {
      // 终局路径必须与超时路径对齐:杀进程、清条目、放行队列。
      // 缺失任一项都会造成 head-of-line 阻塞(下一个实例等到 readyTimer 触发)
      // 与无人回收的存活进程。
      emit(id, 'error', {
        detail: redactLine(`就绪 URL 无法访问（健康探测 ${healthProbeRetries} 次失败）：${url}`)
      })
      entry.stopping = true
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      killTree(entry, 'SIGKILL')
      entries.delete(id)
      entry.settleSpawn?.()
      return
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.ready = true
    entry.url = url
    const port = Number(new URL(url).port)
    entry.port = Number.isInteger(port) && port > 0 ? port : null
    if (stale()) return
    emit(id, 'running', {
      version: entry.version,
      runtimeSource: entry.runtimeSource,
      ...(entry.port !== null ? { port: entry.port } : {}),
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      detail: `已在 ${entry.home} 启动（dsh web）`
    })
      entry.settleSpawn?.() // 排他地放行下一个实例的启动
    } catch (error) {
      failReady(error)
    }
  }

  function watchStdout(id: string, entry: Entry): void {
    const onChunk = (target: 'stdout' | 'stderr') => (chunk: unknown) => {
      const lines = pushLog(entry, chunk)
      if (target === 'stderr') return
      for (const line of lines) {
        const match = READY_PATTERN.exec(line)
        if (match?.[1] && !entry.ready && !entry.stopping) {
          void handleReady(id, entry, match[1])
          return
        }
      }
    }
    const child = entry.child
    // 只有 hub spawn 出来的条目才有 stdout/stderr 可监听(外部接管条目没有)
    if (!child) return
    child.stdout?.on('data', onChunk('stdout'))
    child.stderr?.on('data', onChunk('stderr'))
  }

  /**
   * 解析本次启动的运行时来源（dsh-source-policy）与执行入口。
   * 返回 null 表示终态已由本函数发布（取消或下载未获确认），调用方直接结束本次启动。
   */
  async function resolveLaunch(
    id: string,
    gen: number,
    instance: LocalInstance
  ): Promise<LaunchPlan | null> {
    emit(id, 'starting', { detail: '解析运行时来源' })
    // dush/duush 由用户已安装的启动器直接执行；它实际加载的 dsh 由 hub 经 DSH_BIN 决定。
    // 必须拿到**绝对路径**：裸命令名依赖 PATH 解析，而打包后 GUI 启动的 PATH 未必含用户 bin 目录。
    const customLauncherName =
      instance.launcher !== null && instance.launcher !== 'dsh' ? instance.launcher : null
    const launcherRuntime = customLauncherName
      ? ((await options.pathProbe?.probeLauncher?.(customLauncherName).catch(() => null)) ?? null)
      : null
    // 探测能力存在却没探到：裸命令名在打包后的 PATH 下注定 ENOENT（或被 node 包成
    // MODULE_NOT_FOUND），直接给出可行动的失败原因，不再构造注定失败的调用。
    if (
      customLauncherName !== null &&
      options.pathProbe?.probeLauncher !== undefined &&
      launcherRuntime === null
    ) {
      throw new Error(`未找到启动器 ${customLauncherName}（PATH 与常见安装位置均未探到）`)
    }
    const customLauncher = customLauncherName
      ? (launcherRuntime?.command ?? customLauncherName)
      : null
    // 启动来源判定与升级/版本检查共用 dsh-source-policy：公共空间 + 自定义启动器
    // 固定跟随系统默认 dsh（PATH 实测），不装 hub 副本、不理会实例的固定版本；
    // 隔离空间与默认启动器走同一套来源决策。
    const followSystemDsh = followsSystemDsh(instance.useDefaultSpace, instance.launcher)
    const [hubInstalled, pathRuntime] = await Promise.all([
      followSystemDsh
        ? Promise.resolve([] as string[])
        : options.installer
            .listInstalled()
            .then((items) => items.map((item) => item.version))
            .catch(() => [] as string[]),
      options.pathProbe ? options.pathProbe.probe().catch(() => null) : Promise.resolve(null)
    ])
    const plan = followSystemDsh
      ? pathRuntime === null
        ? null
        : {
            kind: 'path' as const,
            command: pathRuntime.command,
            version: pathRuntime.version,
            reason: 'unpinned-path-any' as const
          }
      : planRuntimeSource({
          desiredVersion: instance.dshVersion,
          hubInstalled,
          pathRuntime
        })
    if ((cancelGeneration.get(id) ?? -1) >= gen) {
      emit(id, 'stopped', { detail: '已取消启动' })
      return null
    }

    // 统一收敛为:执行入口(wrapper 或 dsh) + 显示用 version + 来源标记 + 注入给 wrapper 的 DSH_BIN
    let version: string
    let runtimeSource: 'hub' | 'path'
    let scriptPath: string
    let dshBin: string | null = null
    let resolved: { version: string; source: 'hub' | 'path'; command: string } | null = null
    if (plan?.kind === 'path') {
      resolved = { version: plan.version, source: 'path', command: plan.command }
    } else if (plan?.kind === 'hub') {
      resolved = { version: plan.version, source: 'hub', command: options.installer.resolveEntry(plan.version) }
    } else if (plan?.kind === 'download') {
      // download:目标版本(未固定时解析 registry latest),**必须经用户确认**
      const target = plan.version ?? (await options.installer.resolveDefaultVersion())
      emit(id, 'starting', { version: target, detail: `需要下载 dsh ${target}，等待确认` })
      const confirmed = await options.confirmDownload?.(target)
      if (confirmed !== true) {
        emit(id, 'stopped', {
          version: target,
          detail: `需要下载 dsh ${target}，未获确认，已取消启动（hub 与 PATH 上均无可用运行时）`
        })
        return null
      }
      if ((cancelGeneration.get(id) ?? -1) >= gen) return null
      resolved = { version: target, source: 'hub', command: options.installer.resolveEntry(target) }
    }
    if (customLauncher !== null) {
      scriptPath = customLauncher
      // 系统默认 dsh 未探到的公共实例退回旧显示:创建时选定的版本,未固定则保留 'custom' 占位。
      version = resolved?.version ?? instance.dshVersion ?? 'custom'
      runtimeSource = resolved?.source ?? 'path'
      dshBin = resolved?.command ?? null
    } else {
      if (resolved === null) throw new Error('invalid-launcher')
      scriptPath = resolved.command
      version = resolved.version
      runtimeSource = resolved.source
    }
    return { version, runtimeSource, scriptPath, dshBin, customLauncherName }
  }

  /**
   * 队列内执行一次启动：查重 → 安装 → 分配端口 → spawn → 接管子进程事件 → 等到就绪/退出/超时。
   * 段结束即放行队列里的下一个实例，此时端口与 DSH_HOME 已稳定。
   */
  async function spawnAndWatch(
    id: string,
    gen: number,
    instance: LocalInstance,
    launch: LaunchPlan
  ): Promise<StartOutcome> {
    const { version, runtimeSource, dshBin, customLauncherName } = launch
    // .cmd shim 解析后要回写，故保持可变
    let scriptPath = launch.scriptPath
    // 队列内二次查重:同一 tick 并发 start(双击启动 / 向导自动启动与手动启动竞速)
    // 时,第一次查重发生在首个 await 之前会双双通过,前一个任务可能已把该实例拉起
    const already = entries.get(id)
    if (already && !already.stopping) {
      emit(id, already.ready ? 'running' : 'starting', {
        version: already.version,
        runtimeSource: already.runtimeSource,
        ...(already.port !== null ? { port: already.port } : {}),
        ...(already.command !== undefined ? { command: already.command } : {}),
        detail: '实例已在运行，忽略重复启动'
      })
      return 'duplicate'
    }
    // Generation-based cancel: 取消点 >= 本任务的 generation 时取消
    if ((cancelGeneration.get(id) ?? -1) >= gen) return 'cancelled'
    emit(id, 'starting', {
      version,
      runtimeSource,
      detail:
        runtimeSource === 'path'
          ? `使用本机 dsh ${version} 启动`
          : `准备 dsh ${version} 运行时（首次需要安装，可能较慢）`
    })
    // path 来源运行的是用户本机安装,不需要(也不许)往应用隔离目录安装
    if (runtimeSource === 'hub')
      await options.installer.ensureInstalled(version, (progress) => {
        emit(id, 'installing', { version: progress.version, detail: progress.detail })
      })
    if ((cancelGeneration.get(id) ?? -1) >= gen) return 'cancelled'

    // 优先实例记录里用户选定的端口(向导高级设置);被占则向上递增,启动后仍回写实际端口。
    // 用户端口可能落在默认区间(3080-30999)之外(如 dsh 自身默认 52300):
    // 区间内被占递增到 30999;区间外则向 65535 递进,保证用户端口本身先被尝试,
    // 否则该端口会被静默丢弃且每次启动都漂移新端口
    const portStart = instance.port ?? DEFAULT_LOCAL_PORT
    const portEnd = portStart > DEFAULT_PORT_RANGE_END ? 65_535 : DEFAULT_PORT_RANGE_END
    const preferredPort = await findFreePort({
      start: portStart,
      end: portEnd,
      probe: portProbe
    }).catch(() => 0)
    emit(id, 'starting', {
      version,
      runtimeSource,
      detail:
        preferredPort > 0
          ? `分配端口并启动进程（端口 ${preferredPort}）`
          : '分配端口并启动进程（端口区间不可用，改由 dsh 自动选择）'
    })
    const home = instance.useDefaultSpace
      ? join(homeDir(), '.dsh')
      : join(options.dataRoot, 'homes', id)
    await mkdir(home, { recursive: true })

    // --profile 会直接选择 web profile，不能再附加 web 子命令；所有参数由 Hub 构造，不经 shell 解释。
    // 刻意不传 --host：由 dsh 自己的默认绑定决定（与用户直接运行 `dsh --profile web --port N --no-open` 一致）。
    const profileArgs = ['--profile', instance.profile ?? profile]
    const serverArgs = ['--port', String(preferredPort), '--no-open']
    // win32 的 .cmd shim 无法被 spawn 直接执行（Node 命令注入防护）：解析出入口脚本
    // 交给 node 直跑；解析失败立即失败，不构造注定 EINVAL/ENOENT 的调用。
    if (scriptPath.toLowerCase().endsWith('.cmd')) {
      const script = resolveCmdShim(scriptPath)
      if (script === null) {
        throw new Error(`无法解析启动器脚本（${scriptPath}）`)
      }
      scriptPath = script
    }
    // hub 与 path 来源都优先真实 node：dsh 的原生插件按运行时指纹（Electron 版本白名单）
    // 校验，不在白名单的 Electron 启动即以 code=1 退出；真实 node 不受该限制。
    const runtimeNode = resolveNode(scriptPath)
    const nodeArgs = nodeInvocation.args
    // 环境构造：登录 shell 完整环境 / 仅 PATH（见 resolveBaseEnv）；node 目录始终前置，
    // 保证 dsh 自己 spawn 的子进程解析到同一个 node。
    const baseEnv = await resolveBaseEnv({ inherit: inheritShellEnv(), shellEnv, loginPath })
    const basePath = baseEnv.PATH ?? ''
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      PATH:
        runtimeNode !== null ? `${dirname(runtimeNode)}${delimiter}${basePath}` : basePath,
      DSH_HOME: home
    }
    if (customLauncherName !== null) {
      // dush/duush wrapper 会把自己的隔离 patch 追加到 DUSH_PATCH_FILE；继承用户全局
      // patch 会让同一个 loader entry 加载两次，直接触发 duplicate 报错。
      delete runtimeEnv.DUSH_PATCH_FILE
    }
    if (dshBin !== null) {
      // wrapper 缺省回退 PATH 上的 dsh；注入 DSH_BIN 让它跑 hub 决定的那一份，
      // 状态里显示的版本、升级的目标与实际运行的 dsh 才始终一致。
      runtimeEnv.DSH_BIN = dshBin
    }
    const invocation =
      runtimeNode !== null
        ? {
            command: runtimeNode,
            args: [...nodeArgs, scriptPath, ...profileArgs, ...serverArgs],
            // 让 dsh 自己 spawn 的子进程也能解析到同一个 node。
            env: runtimeEnv
          }
        : runtimeSource === 'path'
          ? {
              // 找不到 node：仍按脚本 shebang 直接执行（用户 PATH 里可能有）。
              // 失败时退出详情会带上脱敏后的子进程日志，能看到 `env: node: ...` 这类原因。
              command: scriptPath,
              args: [...profileArgs, ...serverArgs],
              env: runtimeEnv
            }
          : {
              // hub 来源也找不到 node：回退内置 Electron（版本命中白名单时可用）。
              command: nodeInvocation.command,
              args: [...nodeArgs, scriptPath, ...profileArgs, ...serverArgs],
              env: { ...runtimeEnv, ...nodeInvocation.env, DSH_HOME: home }
            }
    const child = spawnImpl({
      ...invocation,
      cwd: home,
      detached: true
    })

    const entry: Entry = {
      child,
      url: null,
      port: null,
      version,
      command: formatCommandLine(invocation),
      runtimeSource,
      home,
      log: [],
      buffer: '',
      ready: false,
      stopping: false,
      timer: null
    }
    entries.set(id, entry)
    watchStdout(id, entry)

    // 队列放行信号:就绪 / 退出 / 出错 / 超时 任一发生即 settle
    let settleSpawned: (() => void) | null = null
    const spawnSettledPromise = new Promise<void>((resolve) => {
      settleSpawned = resolve
    })
    let settled = false
    entry.settleSpawn = () => {
      if (settled) return
      settled = true
      settleSpawned?.()
    }

    entry.timer = setTimeout(() => {
      // 身份守卫:本 timer 只属于本次尝试,不得误伤替换后的新条目
      if (entries.get(id) !== entry) return
      if (entry.ready || entry.stopping) return
      emit(id, 'error', {
        detail: `启动超时（${Math.round(readyTimeoutMs / 1000)}s）：未解析到就绪 URL${entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''}`
      })
      entry.stopping = true
      killTree(entry, 'SIGKILL')
      entries.delete(id)
      entry.settleSpawn?.()
    }, readyTimeoutMs)
    entry.timer.unref?.()

    child.on('error', (error: Error) => {
      // 身份守卫:陈旧条目的迟到事件不得删除更晚的同 id 条目
      if (entries.get(id) !== entry) return
      if (entry.stopping) return
      entry.stopping = true
      emit(id, 'error', { detail: `进程启动失败：${error.message}` })
      entries.delete(id)
      entry.settleSpawn?.()
    })

    child.on('exit', (code, signal) => {
      // 身份守卫:旧子进程的迟到 exit(SIGKILL 无效的僵尸/D 态)会误删新条目,
      // 让新进程沦为无主、状态错误翻转为 stopped
      if (entries.get(id) !== entry) return
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      entries.delete(id)
      if (entry.stopping) {
        // 停止语义由 stop() 独占发布,这里不再重复 emit(每次正常停止只一条 stopped)
      } else {
        entry.stopping = true // 兜底:防止在途 handleReady 续体继续以「运行中」发布
        emit(id, 'error', {
          // 附上子进程最后几行输出:启动失败时它是唯一的失败原因来源。
          // `logTail` 经 `redactLine` 脱敏(剥掉 URL 查询串),就绪 URL 的 ?token= 不会进入详情。
          detail: `进程意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）${
            entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''
          }`
        })
      }
      entry.settleSpawn?.()
    })

    // 兜底:stop() 若落在「最后一次取消检查 → entries.set」之间(findFreePort/mkdir
    // 都是 await),它只登记了取消意图而看不到条目;这里必须补杀,否则子进程成为
    // 无主孤儿(before-quit 的 stopAll 也扫不到),继续占用端口与 DSH_HOME
    if ((cancelGeneration.get(id) ?? -1) >= gen) {
      entry.stopping = true
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      killTree(entry, 'SIGKILL')
      entries.delete(id)
      entry.settleSpawn?.()
      return 'cancelled'
    }

    // 等到就绪/退出/超时,再放行下一个实例(端口已稳定分配的保证)
    await spawnSettledPromise
    return 'spawned'
  }

  return {
    onStatus,
    onUpgradeProgress(listener) {
      upgradeListeners.add(listener)
      return () => upgradeListeners.delete(listener)
    },

    async upgradeInstance(instance) {
      const id = instance.id
      // 单飞守卫：同一实例的升级进行中重复触发直接忽略，避免并发写同一隔离目录。
      if (upgradingIds.has(id)) return
      upgradingIds.add(id)
      const at = (): string => new Date(now()).toISOString()
      /**
       * 升级主序列：运行中先停 → 下载安装 → 回写版本 → 原样重启，末尾 done=100。
       * 两条升级路径共用；`checking` 由各分支自行发出 —— 系统升级要等二次确认之后
       * 才有进度，隔离升级则要在解析版本之前就给出反馈。
       */
      const runUpgrade = async (
        version: string,
        install: (onProgress: (progress: InstallProgress) => void) => Promise<unknown>
      ): Promise<void> => {
        const wasRunning = this.statusOf(id)?.status === 'running'
        if (wasRunning) await this.stop(id)
        emitUpgrade({ instanceId: id, phase: 'downloading', version, percent: 0, at: at() })
        await install((progress) => {
          emitUpgrade({
            instanceId: id,
            phase: 'installing',
            version,
            percent: progress.percent ?? 0,
            detail: progress.detail,
            at: at()
          })
        })
        await options.store.update(id, { dshVersion: version })
        if (wasRunning) await this.start({ ...instance, dshVersion: version })
        emitUpgrade({ instanceId: id, phase: 'done', version, percent: 100, at: at() })
      }
      try {
        // 升级对象经 dsh-source-policy 判定，与版本检查、启动路径共用同一判据：
        // 结论为「系统默认 dsh」时升级全局 npm 安装，所有共用该 dsh 的实例与终端
        // 都会跟随，因此必须先二次确认。拒绝时直接返回，不产生任何进度事件、不改任何
        // 状态；探测与安装布局判定在确认之前完成，注定失败的升级不先打扰用户。
        // 其余情况（隔离空间，或公共空间实际跑 hub 副本）都升级 hub 自己的运行时。
        const runtimeSource = this.statusOf(id)?.runtimeSource
        if (isExternalRuntime(runtimeSource)) {
          throw new InstanceStoreError('invalid-state', '外部接管的 dsh 进程归用户所有，hub 不能代管升级')
        }
        const decision = await resolveSystemDshUsage({
          transport: instance.transport,
          useDefaultSpace: instance.useDefaultSpace,
          launcher: instance.launcher,
          runtimeSource,
          desiredVersion: instance.dshVersion,
          listInstalledVersions: async () => {
            try {
              return (await options.installer.listInstalled()).map((item) => item.version)
            } catch {
              return [] as string[]
            }
          },
          probePath: async () => (await options.pathProbe?.probe().catch(() => null)) ?? null
        })
        if (decision.usesSystemDsh) {
          const newest = await options.installer.resolveLatestVersion()
          const system = decision.pathRuntime
          if (system === null) {
            throw new Error('未找到系统默认 dsh（PATH 上没有可用的 dsh），无法升级')
          }
          const prefix = await options.installer.resolveGlobalPrefix(system.command)
          if (prefix === null) {
            throw new Error(`系统 dsh 不是 npm 全局安装（${system.command}），hub 无法代管升级`)
          }
          const confirmed = await options.confirmSystemUpgrade?.(newest, system.version)
          if (confirmed !== true) return
          emitUpgrade({ instanceId: id, phase: 'checking', at: at() })
          await runUpgrade(newest, (onProgress) => options.installer.installGlobal(prefix, newest, onProgress))
          return
        }
        emitUpgrade({ instanceId: id, phase: 'checking', at: at() })
        const latest = await options.installer.resolveLatestVersion()
        await runUpgrade(latest, (onProgress) => options.installer.ensureInstalled(latest, onProgress))
      } catch (error) {
        emitUpgrade({
          instanceId: id,
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
          at: at()
        })
      } finally {
        upgradingIds.delete(id)
      }
    },

    statusOf,

    urlOf(id) {
      return entries.get(id)?.url ?? null
    },

    runningIds() {
      return [...entries.keys()]
    },

    async start(instance) {
      const id = instance.id
      const existing = entries.get(id)
      if (existing && !existing.stopping) {
        // 重复 start 只重播一次当前状态,不重复 spawn
        emit(id, existing.ready ? 'running' : 'starting', {
          version: existing.version,
          runtimeSource: existing.runtimeSource,
          ...(existing.port !== null ? { port: existing.port } : {}),
          ...(existing.command !== undefined ? { command: existing.command } : {}),
          detail: '实例已在运行，忽略重复启动'
        })
        return
      }

      // 新的启动请求：递增 generation（不删除旧 cancel，旧 queued task 检查自己的 generation）
      const gen = (instanceGeneration.get(id) ?? 0) + 1
      instanceGeneration.set(id, gen)
      pendingStartCounts.set(id, (pendingStartCounts.get(id) ?? 0) + 1)
      try {
        const launch = await resolveLaunch(id, gen, instance)
        if (launch === null) return
        // 启动阶段串行(含安装):避免多实例并发首启时互相干扰(同版本重复安装/并发冷启动)。
        // 关键:串行段要等到「就绪或退出」才结束 —— 端口探测与 dsh 实际绑定之间存在竞态窗口,
        // 若只等 spawn 就放行,两个实例会抢同一端口,后启动的那个会崩溃。
        const outcome = await enqueueStart(() => spawnAndWatch(id, gen, instance, launch))
        if (outcome === 'cancelled') {
          emit(id, 'stopped', { detail: '已取消启动' })
          return
        }
      } catch (error) {
        emit(id, 'error', {
          detail: error instanceof Error ? error.message : String(error)
        })
      } finally {
        decrementPendingStart(id)
      }
    },

    async stop(id) {
      const entry = entries.get(id)
      // 无论有无条目都登记取消意图:排队中尚未 spawn 的重复 start 也会被一并取消,
      // 否则「start→start→stop」序列下,后一个排队任务会在停止后把实例重新拉起
      // Generation-based:记录当前 generation 作为取消点
      cancelGeneration.set(id, instanceGeneration.get(id) ?? 0)
      if (!entry) {
        emit(id, 'stopped', { detail: '实例未在运行' })
        return
      }
      // 外部接管(hub 没 spawn 过):只断开接管 —— 用户自己的 dsh web 进程必须留着,
      // 我们无权替用户结束它(误杀会连带终止他手工挂着的 patch 实例)。
      if (entry.runtimeSource === 'external') {
        entries.delete(id)
        emit(id, 'stopped', {
          detail: `已断开接管（外部 dsh web 进程 pid ${entry.externalPid ?? '?'} 未终止）`
        })
        return
      }
      entry.stopping = true
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      killTree(entry, 'SIGTERM')
      const exited = await waitForExit(entry, stopGraceMs)
      if (!exited) {
        killTree(entry, 'SIGKILL')
        await waitForExit(entry, 1_000)
      }
      // 身份守卫:stop 期间可能有新 start 替换了条目,只删除自己持有的旧条目
      if (entries.get(id) === entry) entries.delete(id)
      // 必须显式放行启动队列:正常停止由 exit handler 的 settle 兜住,但子进程若处于
      // SIGKILL 也无效的 D 态/僵尸,exit 事件永不触发 → 停在 spawnSettledPromise 的
      // 队列任务永不返回,之后所有实例的 start 全部永久排队(settled 标志保证此处重复无害)
      entry.settleSpawn?.()
      emit(id, 'stopped', { detail: exited ? '已停止' : '已强制停止（SIGKILL）' })
    },

    async adopt(instance, external) {
      const id = instance.id
      const existing = entries.get(id)
      if (existing) {
        // 已在运行(hub 自己拉起的或已接管的):不覆盖,只重播状态
        emit(id, existing.ready ? 'running' : 'starting', {
          version: existing.version,
          runtimeSource: existing.runtimeSource,
          ...(existing.port !== null ? { port: existing.port } : {}),
          detail: '实例已在运行，忽略重复接管'
        })
        return
      }
      const url = external.url ?? `http://127.0.0.1:${external.port}`
      entries.set(id, {
        child: null,
        url,
        port: external.port,
        // 外部进程的版本我们不去猜(hub 未安装、也不该回写):显式留空字符串,
        // 状态事件里由调用方决定是否展示
        version: '',
        runtimeSource: 'external',
        home: '',
        log: [],
        buffer: '',
        ready: true,
        stopping: false,
        timer: null,
        externalPid: external.pid
      })
      emit(id, 'running', {
        port: external.port,
        runtimeSource: 'external',
        detail: `已接管本机运行的 dsh web（pid ${external.pid}${external.patch ? `，patch ${external.patch}` : ''}）`
      })
    },

    async stopAll() {
      // entries 以外，安装/端口分配/全局队列中的启动任务也必须作废，防止退出后再 spawn。
      const ids = new Set([...entries.keys(), ...pendingStartCounts.keys()])
      await Promise.all([...ids].map((id) => this.stop(id)))
      // 队列可能卡在安装等待上：退出路径有界等待；取消代已保证放弃等待后不会迟到 spawn。
      await Promise.race([
        startChain,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, stopAllDrainMs)
          timer.unref?.()
        })
      ])
    }
  }
}