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
import { findFreePort } from './port-allocator'
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
  profile?: string
  readyTimeoutMs?: number
  stopGraceMs?: number
  healthTimeoutMs?: number
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
  ready: boolean
  stopping: boolean
  timer: NodeJS.Timeout | null
}

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
  // Electron 主进程的 process.execPath 是 Electron 本体：以 ELECTRON_RUN_AS_NODE 退化为纯 Node 执行 dsh
  return { command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

export function createLocalRuntime(options: LocalRuntimeOptions): LocalRuntimeManager {
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  const probe = options.probe ?? defaultProbe
  const nodeInvocation = options.nodeInvocation ?? defaultNodeInvocation()
  const profile = options.profile ?? 'web'
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000
  const stopGraceMs = options.stopGraceMs ?? 3_000
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  const now = options.now ?? (() => Date.now())

  const entries = new Map<string, Entry>()
  const statuses = new Map<string, InstanceStatusEvent>()
  const listeners = new Set<(event: InstanceStatusEvent) => void>()

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
    const lines = String(chunk).split(/\r?\n/).filter((line) => line.trim() !== '')
    entry.log.push(...lines)
    if (entry.log.length > LOG_BUFFER_LINES) entry.log.splice(0, entry.log.length - LOG_BUFFER_LINES)
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
    const healthy = await probe(url, healthTimeoutMs)
    if (entry.stopping) return
    if (!healthy) {
      emit(id, 'error', { detail: `就绪 URL 无法访问（健康探测失败）：${url}`, url })
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

      try {
        emit(id, 'starting', { detail: '解析运行时版本' })
        const version = instance.dshVersion ?? (await options.installer.resolveDefaultVersion())

        if (!(await options.installer.isInstalled(version))) {
          emit(id, 'starting', { version, detail: `安装 dsh ${version}（首次较慢）` })
          await options.installer.install(version)
        }

        emit(id, 'starting', { version, detail: '分配端口并启动进程' })
        const preferredPort = await findFreePort().catch(() => 0)
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
          ready: false,
          stopping: false,
          timer: null
        }
        entries.set(id, entry)
        watchStdout(id, entry)

        entry.timer = setTimeout(() => {
          if (entry.ready || entry.stopping) return
          emit(id, 'error', {
            detail: `启动超时（${Math.round(readyTimeoutMs / 1000)}s）：未解析到就绪 URL${entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''}`
          })
          entry.stopping = true
          killTree(entry, 'SIGKILL')
          entries.delete(id)
        }, readyTimeoutMs)
        entry.timer.unref?.()

        child.on('error', (error: Error) => {
          if (entry.stopping) return
          entry.stopping = true
          emit(id, 'error', { detail: `进程启动失败：${error.message}` })
          entries.delete(id)
        })

        child.on('exit', (code, signal) => {
          if (entry.timer) {
            clearTimeout(entry.timer)
            entry.timer = null
          }
          entries.delete(id)
          if (entry.stopping) {
            emit(id, 'stopped', { detail: '已停止' })
            return
          }
          emit(id, 'error', {
            detail: `进程意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）${entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''}`
          })
        })
      } catch (error) {
        emit(id, 'error', {
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    },

    async stop(id) {
      const entry = entries.get(id)
      if (!entry) {
        emit(id, 'stopped', { detail: '实例未在运行' })
        return
      }
      entry.stopping = true
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