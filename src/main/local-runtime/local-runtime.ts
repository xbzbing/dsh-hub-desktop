/**
 * 本地实例运行时（T3）—— 不 import electron（全局规则 5）。
 *
 * 设计依据：设计文档 §4.1（专用 DSH_HOME、spawn 隔离运行时、解析就绪 URL、杀整棵进程树）
 * 与 §4.3（HealthyProbe：任意 HTTP 响应即「传输就绪」）。
 *
 * 状态推进只经 `onStatus` 监听器向外发布（R3 后由 main 进程转成 IPC 事件），
 * 因此本模块可脱离 Electron 单独测试。
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstanceRuntimeStatus, InstanceStatusEvent, LocalInstance } from '@shared/contracts'
import { DEFAULT_PORT_RANGE_START, findFreePort } from './port-allocator'
import type { PortProbe } from './port-allocator'
import type { RuntimeInstaller } from './runtime-installer'

/** dsh 就绪输出：`dsh web: http://127.0.0.1:52300/?token=...` */
const READY_PATTERN = /dsh\s+web:\s+(https?:\/\/\S+)/i

/** 诊断用的日志环形缓冲行数 */
const LOG_BUFFER_LINES = 80

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

export type HealthProbe = (url: string, timeoutMs: number) => Promise<boolean>

export interface LocalRuntimeOptions {
  installer: RuntimeInstaller
  /** 应用数据根：实例 DSH_HOME 落在 `<dataRoot>/homes/<id>`（评审结论 R7） */
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
  /** §4.3 连接期探测重试次数（就绪 URL 先于端口绑定出现时的兜底；默认 5 次） */
  healthProbeRetries?: number
  /** §4.3 连接期探测间隔（默认 500ms） */
  healthProbeRetryMs?: number
  now?: () => number
}

export interface LocalRuntimeManager {
  onStatus(listener: (event: InstanceStatusEvent) => void): () => void
  statusOf(id: string): InstanceStatusEvent | null
  runningIds(): string[]
  /** 立即返回；状态经 onStatus 推进（与 IPC `instances:start` 契约一致） */
  start(instance: LocalInstance): Promise<void>
  stop(id: string): Promise<void>
  stopAll(): Promise<void>
}

interface Entry {
  child: SpawnedProcess
  url: string | null
  port: number | null
  version: string
  home: string
  log: string[]
  /** 未以换行结尾的残片：跨 chunk 的就绪行靠它拼接，否则会漏匹配就绪行 */
  buffer: string
  ready: boolean
  stopping: boolean
  timer: NodeJS.Timeout | null
  /** 队列放行钩子:就绪 / 退出 / 出错 / 超时 任一发生时调用(TOCTOU 防线) */
  settleSpawn?: () => void
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

const defaultProbe: HealthProbe = async (url, timeoutMs) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    // §4.3：任意 HTTP 响应（200/302/401）都表示传输已就绪
    return response.status >= 100 && response.status < 600
  } catch {
    return false
  }
}

function defaultNodeInvocation(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  // Electron 主进程的 process.execPath 是 Electron 本体：以 ELECTRON_RUN_AS_NODE 退化为纯 Node 执行 dsh。
  // `--expose-internals` 是 dsh web profile 的硬性要求（cordis-plugin-hmr 需要），缺失时就绪后即崩
  // （实测:node 与 electron-as-node 均需该标志才能稳定存活）。
  return { command: process.execPath, args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

export function createLocalRuntime(options: LocalRuntimeOptions): LocalRuntimeManager {
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  const probe = options.probe ?? defaultProbe
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
    return entry.log.slice(-lines).join(' / ')
  }

  function killTree(entry: Entry, signal: NodeJS.Signals): void {
    const pid = entry.child.pid
    if (pid === undefined) return
    try {
      // detached 启动 → 子进程自成进程组，负 pid 杀整组（包装 shell + 其全部后代）
      process.kill(-pid, signal)
    } catch {
      try {
        entry.child.kill(signal)
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
      entry.child.on('exit', () => finish(true))
    })
  }

  async function handleReady(id: string, entry: Entry, url: string): Promise<void> {
    // §4.3:连接期探测频率 500ms —— 兜住「先打印就绪 URL、后绑定端口」的打印先行 TOCTOU
    let healthy = false
    for (let attempt = 1; attempt <= healthProbeRetries; attempt++) {
      if (entry.stopping) return
      healthy = await probe(url, healthTimeoutMs)
      if (healthy) break
      if (attempt < healthProbeRetries) {
        await new Promise<void>((resolve) => {
          const delay = setTimeout(resolve, healthProbeRetryMs)
          delay.unref?.()
        })
      }
    }
    if (entry.stopping) return
    if (!healthy) {
      // 终局路径必须与超时路径对齐:杀进程、清条目、放行队列。
      // 缺失任一项都会造成 head-of-line 阻塞(下一个实例等到 readyTimer 触发)
      // 与无人回收的存活进程。
      emit(id, 'error', {
        detail: `就绪 URL 无法访问（健康探测 ${healthProbeRetries} 次失败）：${url}`,
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
    emit(id, 'running', {
      url,
      version: entry.version,
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
    entry.child.stdout?.on('data', onChunk('stdout'))
    entry.child.stderr?.on('data', onChunk('stderr'))
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
        const current = statuses.get(id)
        emit(id, existing.ready ? 'running' : 'starting', {
          version: existing.version,
          ...(existing.url ? { url: existing.url } : {}),
          ...(existing.port !== null ? { port: existing.port } : {}),
          detail: '实例已在运行，忽略重复启动'
        })
        if (current?.status === 'running' && existing.url) return
        return
      }

      cancelRequested.delete(id) // 显式重启优先于此前排队期间的取消意图
      try {
        emit(id, 'starting', { detail: '解析运行时版本' })
        const version = instance.dshVersion ?? (await options.installer.resolveDefaultVersion())
        if (cancelRequested.delete(id)) {
          emit(id, 'stopped', { detail: '已取消启动' })
          return
        }

        // 启动阶段串行(含安装):避免多实例并发首启时互相干扰(同版本重复安装/并发冷启动)。
          // 关键:串行段要等到「就绪或退出」才结束 —— 端口探测与 dsh 实际绑定之间存在
          // TOCTOU 窗口(设计文档 §4.1),若只等 spawn 就放行,两个实例会抢同一端口后者崩溃。
          const outcome = await enqueueStart(async (): Promise<StartOutcome> => {
            // 队列内二次查重:同一 tick 并发 start(双击启动 / 向导自动启动与手动启动竞速)
            // 时,第一次查重发生在首个 await 之前会双双通过,前一个任务可能已把该实例拉起
            const already = entries.get(id)
            if (already) {
              emit(id, already.ready ? 'running' : 'starting', {
                version: already.version,
                ...(already.url ? { url: already.url } : {}),
                ...(already.port !== null ? { port: already.port } : {}),
                detail: '实例已在运行，忽略重复启动'
              })
              return 'duplicate'
            }
            if (cancelRequested.delete(id)) return 'cancelled'
            emit(id, 'starting', {
              version,
              detail: `准备 dsh ${version} 运行时（首次需要安装，可能较慢）`
            })
            await options.installer.ensureInstalled(version)
            if (cancelRequested.delete(id)) return 'cancelled'

            emit(id, 'starting', { version, detail: '分配端口并启动进程' })
            // 优先实例记录里用户选定的端口(向导高级设置);被占则向上递增,启动后仍回写实际端口
            const preferredPort = await findFreePort(
              portProbe
                ? { start: instance.port ?? DEFAULT_PORT_RANGE_START, probe: portProbe }
                : { start: instance.port ?? DEFAULT_PORT_RANGE_START }
            ).catch(() => 0)
          const home = join(options.dataRoot, 'homes', id)
          await mkdir(home, { recursive: true })

          const child = spawnImpl({
            command: nodeInvocation.command,
            args: [
              ...nodeInvocation.args,
              options.installer.resolveEntry(version),
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
              emit(id, 'stopped', { detail: '已停止' })
            } else {
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
      emit(id, 'stopped', { detail: exited ? '已停止' : '已强制停止（SIGKILL）' })
    },

    async stopAll() {
      const ids = [...entries.keys()]
      await Promise.all(ids.map((id) => this.stop(id)))
    }
  }
}