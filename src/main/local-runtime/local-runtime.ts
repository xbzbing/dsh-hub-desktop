/**
 *
 *
 * 因此本模块可脱离 Electron 单独测试。
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstanceRuntimeStatus, InstanceStatusEvent, LocalInstance } from '@shared/contracts'
import { redactLine } from '@shared/redact'
import { DEFAULT_PORT_RANGE_END, DEFAULT_PORT_RANGE_START, findFreePort } from './port-allocator'
import type { PortProbe } from './port-allocator'
import type { RuntimeInstaller } from './runtime-installer'
import { planRuntimeSource, type PathProbe } from './runtime-source'
import { httpHealthProbe, type HealthProbe } from '../transport/probe'

export type { HealthProbe } // 保持既有导出；类型定义位于 transport/probe.ts。

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
  /** 缺省用 Electron 自带 Node（ELECTRON_RUN_AS_NODE）执行 dsh 入口 */
  nodeInvocation?: { command: string; args: string[]; env: NodeJS.ProcessEnv }
  spawnImpl?: SpawnLike
  probe?: HealthProbe
  /** 端口可绑定探测（注入以便测试端口分配时序；缺省用真实 bind 探测） */
  portProbe?: PortProbe
  profile?: string
  readyTimeoutMs?: number
  stopGraceMs?: number
  healthTimeoutMs?: number
  healthProbeRetries?: number
  healthProbeRetryMs?: number
  now?: () => number
  /**
   * (决策退化为「hub → 下载」两级,与旧行为兼容)。
   */
  pathProbe?: PathProbe
  /**
   * (生产装配必须注入;测试/受限环境注入 stub)。返回 true 才继续下载。
   */
  confirmDownload?: (version: string) => Promise<boolean>
}

export interface LocalRuntimeManager {
  onStatus(listener: (event: InstanceStatusEvent) => void): () => void
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

const defaultSpawn: SpawnLike = ({ command, args, env, cwd, detached }) =>
  spawn(command, args, {
    env,
    cwd,
    detached,
    stdio: ['ignore', 'pipe', 'pipe']
  })

function defaultNodeInvocation(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  // Electron 主进程的 process.execPath 是 Electron 本体：以 ELECTRON_RUN_AS_NODE 退化为纯 Node 执行 dsh。
  // `--expose-internals` 是 dsh web profile 的硬性要求（cordis-plugin-hmr 需要），缺失时就绪后即崩

  return { command: process.execPath, args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

export function createLocalRuntime(options: LocalRuntimeOptions): LocalRuntimeManager {
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  const probe = options.probe ?? httpHealthProbe
  const nodeInvocation = options.nodeInvocation ?? defaultNodeInvocation()
  const profile = options.profile ?? 'web'
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000
  const stopGraceMs = options.stopGraceMs ?? 3_000
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  const healthProbeRetries = options.healthProbeRetries ?? 5
  const healthProbeRetryMs = options.healthProbeRetryMs ?? 500
  const portProbe = options.portProbe
  const now = options.now ?? (() => Date.now())

  const entries = new Map<string, Entry>()
  const statuses = new Map<string, InstanceStatusEvent>()
  const listeners = new Set<(event: InstanceStatusEvent) => void>()
  /** 启动阶段串行队列：同一时刻只让一个实例走完「安装 → 分配端口 → spawn → 就绪」 */
  let startChain: Promise<unknown> = Promise.resolve()
  /** 在排队期间被 stop 的实例：轮到它启动时直接放弃 */
  const cancelRequested = new Set<string>()

  function enqueueStart<T>(task: () => Promise<T>): Promise<T> {
    const next = startChain.then(task, task)
    startChain = next.catch(() => undefined)
    return next
  }

  function emit(id: string, status: InstanceRuntimeStatus, extra: Partial<InstanceStatusEvent> = {}): void {
    const event: InstanceStatusEvent = {
      id,
      status,
      at: new Date(now()).toISOString(),
      ...extra
    }
    statuses.set(id, event)
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[local-runtime] 状态监听器抛错：', error)
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
    // 在途续体身份守卫:探测/重试期间本条目的进程可能已退出(退出处理器会删条目并立即

    // 也不得在失败终局里 `entries.delete(id)` 误删新条目 —— 否则活进程沦为无主,
    // 下次 start 又 spawn 一个,两个 dsh 共享同一 DSH_HOME。
    const stale = (): boolean => entry.stopping || entries.get(id) !== entry
    let healthy = false
    for (let attempt = 1; attempt <= healthProbeRetries; attempt++) {
      if (stale()) return
      healthy = await probe(url, healthTimeoutMs)
      if (healthy) break
      if (attempt < healthProbeRetries) {
        await new Promise<void>((resolve) => {
          const delay = setTimeout(resolve, healthProbeRetryMs)
          delay.unref?.()
        })
      }
    }
    if (stale()) return
    if (!healthy) {
      // 终局路径必须与超时路径对齐:杀进程、清条目、放行队列。
      // 缺失任一项都会造成 head-of-line 阻塞(下一个实例等到 readyTimer 触发)
      // 与无人回收的存活进程。
      emit(id, 'error', {
        detail: redactLine(`就绪 URL 无法访问（健康探测 ${healthProbeRetries} 次失败）：${url}`),
        url
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
      url,
      version: entry.version,
      runtimeSource: entry.runtimeSource,
      ...(entry.port !== null ? { port: entry.port } : {}),
      detail: `已在 ${entry.home} 启动（dsh web）`
    })
    entry.settleSpawn?.() // 排他地放行下一个实例的启动
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

  return {
    onStatus(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    statusOf(id) {
      return statuses.get(id) ?? null
    },

    runningIds() {
      return [...entries.keys()]
    },

    async start(instance) {
      const id = instance.id
      const existing = entries.get(id)
      if (existing) {
        // 重复 start 只重播一次当前状态,不重复 spawn
        emit(id, existing.ready ? 'running' : 'starting', {
          version: existing.version,
          runtimeSource: existing.runtimeSource,
          ...(existing.url ? { url: existing.url } : {}),
          ...(existing.port !== null ? { port: existing.port } : {}),
          detail: '实例已在运行，忽略重复启动'
        })
        return
      }

      cancelRequested.delete(id) // 新的启动请求取消之前排队的停止请求
      try {
        emit(id, 'starting', { detail: '解析运行时来源' })
        // 探测与决策在启动队列外完成(纯读);hub 清单与 PATH 探测并行,互不拖慢。
        const [hubInstalled, pathRuntime] = await Promise.all([
          options.installer
            .listInstalled()
            .then((items) => items.map((item) => item.version))
            .catch(() => [] as string[]),
          options.pathProbe ? options.pathProbe.probe().catch(() => null) : Promise.resolve(null)
        ])
        const plan = planRuntimeSource({
          desiredVersion: instance.dshVersion,
          hubInstalled,
          pathRuntime
        })
        if (cancelRequested.delete(id)) {
          emit(id, 'stopped', { detail: '已取消启动' })
          return
        }

        // 统一收敛为:显示用 version + 来源标记 + 「实际要跑的脚本路径」(path 来源 = 用户 bin;hub 来源 = 隔离目录入口)
        let version: string
        let runtimeSource: 'hub' | 'path'
        let scriptPath: string
        if (plan.kind === 'path') {
          version = plan.version
          runtimeSource = 'path'
          scriptPath = plan.command
        } else if (plan.kind === 'hub') {
          version = plan.version
          runtimeSource = 'hub'
          scriptPath = options.installer.resolveEntry(plan.version)
        } else {
          // download:目标版本(未固定时解析 registry latest),**必须经用户确认**
          const target = plan.version ?? (await options.installer.resolveDefaultVersion())
          emit(id, 'starting', { version: target, detail: `需要下载 dsh ${target}，等待确认` })
          const confirmed = await options.confirmDownload?.(target)
          if (confirmed !== true) {
            emit(id, 'stopped', {
              version: target,
              detail: `需要下载 dsh ${target}，未获确认，已取消启动（hub 与 PATH 上均无可用运行时）`
            })
            return
          }
          if (cancelRequested.delete(id)) return
          version = target
          runtimeSource = 'hub'
          scriptPath = options.installer.resolveEntry(target)
        }

        // 启动阶段串行(含安装):避免多实例并发首启时互相干扰(同版本重复安装/并发冷启动)。
        // 关键:串行段要等到「就绪或退出」才结束 —— 端口探测与 dsh 实际绑定之间存在
        const outcome = await enqueueStart(async (): Promise<StartOutcome> => {
            // 队列内二次查重:同一 tick 并发 start(双击启动 / 向导自动启动与手动启动竞速)
            // 时,第一次查重发生在首个 await 之前会双双通过,前一个任务可能已把该实例拉起
            const already = entries.get(id)
            if (already) {
              emit(id, already.ready ? 'running' : 'starting', {
                version: already.version,
                runtimeSource: already.runtimeSource,
                ...(already.url ? { url: already.url } : {}),
                ...(already.port !== null ? { port: already.port } : {}),
                detail: '实例已在运行，忽略重复启动'
              })
              return 'duplicate'
            }
            if (cancelRequested.delete(id)) return 'cancelled'
            emit(id, 'starting', {
              version,
              runtimeSource,
              detail:
                runtimeSource === 'path'
                  ? `使用本机 dsh ${version} 启动`
                  : `准备 dsh ${version} 运行时（首次需要安装，可能较慢）`
            })
            // path 来源运行的是用户本机安装,不需要(也不许)往应用隔离目录安装
            if (runtimeSource === 'hub') await options.installer.ensureInstalled(version)
            if (cancelRequested.delete(id)) return 'cancelled'

            // 优先实例记录里用户选定的端口(向导高级设置);被占则向上递增,启动后仍回写实际端口。
            // 用户端口可能落在 hub 默认区间(30000-30999)之外(如 dsh 自身默认 52300):
            // 区间内被占递增到 30999;区间外则向 65535 递进,保证用户端口本身先被尝试,
            // 否则该端口会被静默丢弃且每次启动都漂移新端口
            const portStart = instance.port ?? DEFAULT_PORT_RANGE_START
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
          const home = join(options.dataRoot, 'homes', id)
          await mkdir(home, { recursive: true })

          // path 来源:scriptPath = 用户 PATH 上的 dsh bin(node 包装脚本);
          // 仍经 nodeInvocation(带 --expose-internals)执行 —— cordis-plugin-hmr
          // 对该标志是硬依赖,node 与 electron-as-node 都需要(见 defaultNodeInvocation 注释)
          const child = spawnImpl({
            command: nodeInvocation.command,
            args: [
              ...nodeInvocation.args,
              scriptPath,
              '--profile',
              profile,
              '--host',
              '127.0.0.1',
              '--port',
              String(preferredPort),
              '--no-open'
            ],
            env: { ...process.env, ...nodeInvocation.env, DSH_HOME: home },
            cwd: home,
            detached: true
          })

          const entry: Entry = {
            child,
            url: null,
            port: null,
            version,
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
                detail: `进程意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）${entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''}`
              })
            }
            entry.settleSpawn?.()
          })

          // 兜底:stop() 若落在「最后一次取消检查 → entries.set」之间(findFreePort/mkdir
          // 都是 await),它只登记了取消意图而看不到条目;这里必须补杀,否则子进程成为
          // 无主孤儿(before-quit 的 stopAll 也扫不到),继续占用端口与 DSH_HOME
          if (cancelRequested.delete(id)) {
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
        })

        if (outcome === 'cancelled') {
          emit(id, 'stopped', { detail: '已取消启动' })
          return
        }
      } catch (error) {
        emit(id, 'error', {
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    },

    async stop(id) {
      const entry = entries.get(id)
      // 无论有无条目都登记取消意图:排队中尚未 spawn 的重复 start 也会被一并取消,
      // 否则「start→start→stop」序列下,后一个排队任务会在停止后把实例重新拉起
      cancelRequested.add(id)
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
      entries.delete(id)
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
          ...(existing.url ? { url: existing.url } : {}),
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
      const ids = [...entries.keys()]
      await Promise.all(ids.map((id) => this.stop(id)))
    }
  }
}