/**
 * SSH 隧道管理器（T4,设计文档 §4.2 / 实现计划 §6.3）—— 不 import electron。
 *
 * 生命周期：start 分配并保留本地端口 → spawn 系统 OpenSSH（`ssh -N -L`，参数库见
 * ssh-args.ts）→ §4.3 健康探测通过 → running；进程意外退出 → 归因分类（exit code +
 * stderr 特征）→ 指数退避 1→2→4→…→30s 自动重连，稳定运行 ≥ stableResetMs 后重置
 * 退避（设计文档 §4.2 看门狗）；端口转发失败（本地端口被占）时重连前重新分配端口。
 *
 * 状态推进只经 `onStatus` 向外发布，本模块可脱离 Electron 单独测试。
 */
import { mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstanceRuntimeStatus, InstanceStatusEvent, SshInstance } from '@shared/contracts'
import {
  DEFAULT_PORT_RANGE_END,
  DEFAULT_PORT_RANGE_START,
  findFreePort,
  isPortFree
} from '../local-runtime/port-allocator'
import type { PortProbe } from '../local-runtime/port-allocator'
import {
  askpassSocketPath,
  ensureAskpassScripts,
  startAskpassServer,
  type AskpassServer
} from '../ssh/askpass'
import {
  createHostTrustProbe,
  evaluateHostTrust,
  hostTargetLabel,
  knownHostsHostField,
  recordHostTrust,
  toFingerprints,
  type HostKeyEntry,
  type HostKeyPrompt
} from '../ssh/host-trust'
import { classifySshExit, type SshExitAttribution } from './attribution'
import { sshTunnelEndpoint } from './endpoint-resolver'
import { httpHealthProbe, sleep, type HealthProbe } from './probe'
import { buildSshArgs } from './ssh-args'
import {
  detachedSpawn,
  killProcessGroup,
  waitForProcessExit,
  type SpawnLike,
  type SpawnedProcess
} from './spawn'

/** 诊断用的日志环形缓冲行数与残片上限（与 local-runtime 同构） */
const LOG_BUFFER_LINES = 40
const LOG_BUFFER_MAX = 64 * 1024

export interface SshTunnelOptions {
  /** 应用数据根：ControlPath / 私有 known_hosts 落在 `<dataRoot>/ssh/` */
  dataRoot: string
  /** ssh 可执行文件（缺省 `ssh`，跟随 PATH） */
  sshCommand?: string
  /** 注入假 spawn 以便单测（缺省真 spawn + detached） */
  spawnImpl?: SpawnLike
  /** §4.3 健康探测（缺省任意 HTTP 响应即就绪） */
  probe?: HealthProbe
  /** 端口可绑定探测（含本管理器保留集；缺省真实 bind 探测） */
  portProbe?: PortProbe
  healthTimeoutMs?: number
  /** 连接期探测频率（§4.3：500ms） */
  healthProbeRetryMs?: number
  /** 就绪探测总期限（含远端 dsh 未就绪的容忍，默认 30s） */
  readyTimeoutMs?: number
  /** 看门狗退避基数（设计 §4.2：1s） */
  backoffBaseMs?: number
  /** 看门狗退避上限（设计 §4.2：30s） */
  backoffMaxMs?: number
  /** 稳定运行多久后重置退避（设计 §4.2：60s） */
  stableResetMs?: number
  stopGraceMs?: number
  now?: () => number
  /** T5 askpass:ssh 索要口令/密钥口令时询问用户(返回 null = 取消);未接线则不启用 */
  askpass?: (request: { instanceId: string; prompt: string }) => Promise<string | null>
  /** T5 TOFU:新主机/指纹变化时请用户确认;未接线则跳过确认(单测路径) */
  confirmHostKey?: (request: HostKeyPrompt) => Promise<'trust' | 'reject'>
  /** askpass helper 使用的 Node 命令(缺省 process.execPath + ELECTRON_RUN_AS_NODE) */
  askpassNode?: { command: string; args: string[] }
}

export interface SshTunnelManager {
  onStatus(listener: (event: InstanceStatusEvent) => void): () => void
  statusOf(id: string): InstanceStatusEvent | null
  runningIds(): string[]
  /** 立即返回；进展经 onStatus 推进（与 IPC `instances:start` 契约一致） */
  start(instance: SshInstance): Promise<void>
  stop(id: string): Promise<void>
  stopAll(): Promise<void>
}

interface TunnelEntry {
  id: string
  child: SpawnedProcess | null
  localPort: number
  /** 远端目标展示标签（如 `myhost:3080`） */
  remoteLabel: string
  url: string
  log: string[]
  buffer: string
  ready: boolean
  stopping: boolean
  reconnectScheduled: boolean
  reconnectTimer: NodeJS.Timeout | null
  /** 当前退避：断线后先等 backoffMs 再重连，随后翻倍（上限 backoffMaxMs） */
  backoffMs: number
  /** 最近一次就绪时刻；null = 当前不在稳定运行 */
  stableSince: number | null
  /** 就绪超时主动杀死子进程时携带的归因（exit handler 消费） */
  pendingReason: SshExitAttribution | null
  /** 上次退出归因为端口转发失败 → 重连前换端口 */
  forwardFailed: boolean
  reconnectCount: number
  controlPath: string
  /** 本实例的 askpass socket 服务(T5);stop 时关闭 */
  askpassServer: AskpassServer | null
  /** SSH_ASKPASS 指向的包装脚本路径(T5 起用) */
  askpassWrapperPath: string | null
}

/** 本实例 ControlPath 基础目录：unix socket 名上限 104 字节（含 NUL），ssh 还会给
 *  ControlPath 追加 ~16 字符随机后缀；数据目录过长（如仓库内嵌路径）时退化为
 *  系统临时目录（按 dataRoot 哈希隔离），保证隧道在任何路径下可用。
 *  实测：`%C` 展开 40 字符 SHA-1 超长；`ssh -N … too long for Unix domain socket`。 */
export function socketsDirFor(dataRoot: string): string {
  const home = join(dataRoot, 'ssh')
  const worst = join(home, `ctl-${'0'.repeat(12)}`) // 名字最长形态
  if (worst.length + 17 < 104) return home
  return join(tmpdir(), `dsh-hub-ssh-${createHash('sha1').update(dataRoot).digest('hex').slice(0, 8)}`)
}

/** 每实例 ControlPath slug：实例 UUID 前 12 hex（设计 §4.2「ControlPath 每实例独立」）。
 *  不能按目标哈希共享：多实例/多次重连会命中同一主连接，旧进程被新实例「借用」后
 *  hub 追不回自己的隧道（实测：遗留 ssh 进程累积、hub 只杀得到最后一个）。 */
export function controlSlug(instance: SshInstance): string {
  return instance.id.replace(/-/g, '').slice(0, 12)
}

export function createSshTunnels(options: SshTunnelOptions): SshTunnelManager {
  const dataRoot = options.dataRoot
  const sshCommand = options.sshCommand ?? 'ssh'
  const spawnImpl = options.spawnImpl ?? detachedSpawn
  const probe = options.probe ?? httpHealthProbe
  const portProbe = options.portProbe
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  const healthProbeRetryMs = options.healthProbeRetryMs ?? 500
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000
  const backoffBaseMs = options.backoffBaseMs ?? 1_000
  const backoffMaxMs = options.backoffMaxMs ?? 30_000
  const stableResetMs = options.stableResetMs ?? 60_000
  const stopGraceMs = options.stopGraceMs ?? 3_000
  const now = options.now ?? (() => Date.now())
  const askpass = options.askpass
  const confirmHostKey = options.confirmHostKey
  const askpassNode = options.askpassNode ?? { command: process.execPath, args: [] }

  const entries = new Map<string, TunnelEntry>()
  const statuses = new Map<string, InstanceStatusEvent>()
  const listeners = new Set<(event: InstanceStatusEvent) => void>()
  /** 同 id 并发 start 的同步闸（start 入口即占用，finally 释放） */
  const startingIds = new Set<string>()
  /** 排队期间被 stop 的实例：轮到它 spawn 前直接放弃 */
  const cancelRequested = new Set<string>()
  /** 本管理器已保留的本地端口（并发分配互斥，防两个隧道抢同一端口） */
  const reservedPorts = new Set<number>()
  /** 重连时需要的实例最新配置；start 登记、stop/删除清理 */
  const latestInstances = new Map<string, SshInstance>()

  function emit(id: string, status: InstanceRuntimeStatus, extra: Partial<InstanceStatusEvent> = {}): void {
    const event: InstanceStatusEvent = { id, status, at: new Date(now()).toISOString(), ...extra }
    statuses.set(id, event)
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[ssh-tunnel] 状态监听器抛错：', error)
      }
    }
  }

  function pushLog(entry: TunnelEntry, chunk: unknown): void {
    entry.buffer += String(chunk)
    // 无换行残片上限（超长单行异常输出），只保留尾部防无界增长
    if (entry.buffer.length > LOG_BUFFER_MAX) entry.buffer = entry.buffer.slice(-LOG_BUFFER_MAX)
    let newlineIndex: number
    while ((newlineIndex = entry.buffer.indexOf('\n')) !== -1) {
      const line = entry.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      entry.buffer = entry.buffer.slice(newlineIndex + 1)
      if (line.trim() !== '') entry.log.push(line)
    }
    if (entry.log.length > LOG_BUFFER_LINES) entry.log.splice(0, entry.log.length - LOG_BUFFER_LINES)
  }

  /** T5 TOFU:连接前校验服务器指纹(未见过 → 询问;变化 → 告警/拒绝) */
  async function ensureTrust(instance: SshInstance, emitWaiting: (detail: string) => void): Promise<boolean> {
    const knownHostsPath = join(dataRoot, 'ssh', 'known_hosts')
    const hostField = knownHostsHostField(instance.host, instance.port)
    const probe = createHostTrustProbe(instance.host, instance.port, { knownHostsPath })
    const trusted = await probe.readTrusted()
    let scanned: HostKeyEntry[]
    try {
      scanned = await probe.scan()
    } catch {
      // keyscan 拿不到公钥(主机不可达/网络抖动):不做 TOFU 判定,交给 ssh 自己连接并归因
      return true
    }
    if (scanned.length === 0) return true
    const evaluation = evaluateHostTrust(trusted, scanned)
    if (evaluation.verdict === 'trusted') return true
    if (!confirmHostKey) return true // 未接线(单测)则直接放行
    emitWaiting(
      evaluation.verdict === 'changed' ? '等待确认服务器指纹（已变化）' : '等待确认服务器指纹'
    )
    const decision = await confirmHostKey({
      instanceId: instance.id,
      target: hostTargetLabel(instance.host, instance.port),
      verdict: evaluation.verdict,
      fingerprints: toFingerprints(scanned),
      previousFingerprints: toFingerprints(evaluation.mismatched)
    })
    if (decision !== 'trust') return false
    await recordHostTrust(
      knownHostsPath,
      hostField,
      scanned,
      evaluation.verdict === 'changed' ? 'replace' : 'append'
    )
    return true
  }

  /** T5 askpass:按实例起一条 unix socket 服务,把 ssh 的口令提示转给用户 */
  async function startAskpassFor(entry: TunnelEntry): Promise<AskpassServer | null> {
    if (!askpass) return null
    const scripts = await ensureAskpassScripts(join(dataRoot, 'ssh'), askpassNode.command, askpassNode.args)
    const server = await startAskpassServer({
      socketPath: askpassSocketPath(socketsDirFor(dataRoot), controlSlug2(entry)),
      onPrompt: async ({ prompt }) => {
        emit(entry.id, 'starting', { detail: '等待输入 SSH 口令（不落盘）' })
        const secret = await askpass({ instanceId: entry.id, prompt })
        if (secret !== null) emit(entry.id, 'starting', { detail: '已收到口令，继续建立隧道' })
        return secret
      }
    })
    entry.askpassWrapperPath = scripts.wrapperPath
    return server
  }

  /** askpass socket 用的实例 slug(= 实例 UUID 前 12 hex) */
  function controlSlug2(entry: TunnelEntry): string {
    return entry.id.replace(/-/g, '').slice(0, 12)
  }

  /** 端口可用性 = 未被本管理器保留 + 可绑定（portProbe 可注入） */
  async function isPortAvailable(port: number): Promise<boolean> {
    if (reservedPorts.has(port)) return false
    if (portProbe) return portProbe(port)
    return isPortFree(port)
  }

  /** 本地端口分配串行链：保留集的 check-then-add 必须原子，并发分配不得抢到同一端口 */
  let allocChain: Promise<unknown> = Promise.resolve()

  /** 分配并保留本地端口：优先沿用实例已持久化的 localPort（被占则递增），区间外向 65535 递进 */
  function allocLocalPort(instance: SshInstance): Promise<number> {
    const next = allocChain.then(() => allocLocalPortInner(instance))
    allocChain = next.catch(() => undefined)
    return next
  }

  async function allocLocalPortInner(instance: SshInstance): Promise<number> {
    const preferred = instance.localPort
    if (preferred !== null && (await isPortAvailable(preferred))) {
      reservedPorts.add(preferred)
      return preferred
    }
    const start = preferred ?? DEFAULT_PORT_RANGE_START
    const end = start > DEFAULT_PORT_RANGE_END ? 65_535 : DEFAULT_PORT_RANGE_END
    const port = await findFreePort({ start, end, probe: isPortAvailable })
    reservedPorts.add(port)
    return port
  }

  function spawnSsh(entry: TunnelEntry, instance: SshInstance): SpawnedProcess {
    const args = buildSshArgs(instance, entry.localPort, {
      controlPath: entry.controlPath,
      knownHostsPath: join(dataRoot, 'ssh', 'known_hosts')
    })
    // T5:启用 askpass（SSH_ASKPASS 指向运行时写入的包装脚本 + REQUIRE=force）
    // - DISPLAY 需非空,OpenSSH 才会走 askpass 分支（无 tty 场景）
    // - ELECTRON_RUN_AS_NODE=1 让包装脚本用 Electron 自带 Node 执行 helper
    // - DSH_HUB_ASKPASS_SOCKET 指向本实例的 unix socket
    const askpassEnv = entry.askpassWrapperPath
      ? {
          SSH_ASKPASS: entry.askpassWrapperPath,
          SSH_ASKPASS_REQUIRE: 'force',
          DISPLAY: process.env['DISPLAY'] ?? 'dsh-hub',
          ELECTRON_RUN_AS_NODE: '1',
          DSH_HUB_ASKPASS_SOCKET: askpassSocketPath(socketsDirFor(dataRoot), controlSlug2(entry))
        }
      : { SSH_ASKPASS_REQUIRE: 'never' as const }
    const child = spawnImpl({
      command: sshCommand,
      args,
      env: { ...process.env, ...askpassEnv },
      cwd: join(dataRoot, 'ssh'),
      detached: true
    })
    attachHandlers(child, entry)
    return child
  }

  /** 端口可用性探测（findFreePort 的 probe 注入点，含保留集） */
  const portAvailabilityProbe = (port: number): Promise<boolean> => {
    return isPortAvailable(port)
  }

  /** 就绪探测：§4.3 连接期 500ms 一探，直到进入 readyTimeout 或进程退出 */
  async function waitForReady(entry: TunnelEntry): Promise<void> {
    if (entry.stopping) return
    const deadline = now() + readyTimeoutMs
    while (now() < deadline) {
      if (entry.stopping) return
      const healthy = await probe(entry.url, healthTimeoutMs)
      if (healthy) {
        if (entry.stopping) return
        entry.ready = true
        entry.stableSince = now()
        entry.forwardFailed = false
        emit(entry.id, 'running', {
          url: entry.url,
          port: entry.localPort,
          detail: `SSH 隧道已就绪（127.0.0.1:${entry.localPort} → ${entry.remoteLabel}）`
        })
        return
      }
      if (entry.stopping) return
      await sleep(healthProbeRetryMs)
    }
    // 就绪期限内远端 dsh 未响应：杀掉隧道，让看门狗按退避重连（远端可能正在重启）
    entry.pendingReason = { kind: 'connect', message: '远端 dsh 未就绪' }
    if (entry.child) {
      killProcessGroup(entry.child, 'SIGKILL')
      const exited = await waitForProcessExit(entry.child, stopGraceMs)
      if (!exited) {
        // 僵尸兜底：exit 事件不来的话，也要让用户看到归因并安排重连
        entry.pendingReason = null
        emit(entry.id, 'error', { detail: '远端 dsh 未就绪（就绪探测超时），即将自动重连' })
        scheduleReconnect(entry)
      }
    } else {
      emit(entry.id, 'error', { detail: '远端 dsh 未就绪（就绪探测超时），即将自动重连' })
      scheduleReconnect(entry)
    }
  }

  /** 取消已排队的重连：清 timer **必须同时复位 reconnectScheduled**,
   *  否则后续 scheduleReconnect 会被幂等守卫短路 → 看门狗永久卡死
   *  （实测:僵尸兜底先 schedule、迟到 exit 又清 timer 时就复现） */
  function cancelReconnect(entry: TunnelEntry): void {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
    }
    entry.reconnectScheduled = false
  }

  /** 看门狗：按当前退避调度重连（幂等：已调度则不重复） */
  function scheduleReconnect(entry: TunnelEntry): void {
    if (entry.stopping || entry.reconnectScheduled) return
    entry.reconnectScheduled = true
    const waitMs = entry.backoffMs
    entry.backoffMs = Math.min(entry.backoffMs * 2, backoffMaxMs)
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectScheduled = false
      entry.reconnectTimer = null
      if (entry.stopping) return
      void reconnect(entry)
    }, waitMs)
    entry.reconnectTimer.unref?.()
  }

  async function reconnect(entry: TunnelEntry): Promise<void> {
    if (entry.stopping) return
    entry.reconnectCount += 1
    emit(entry.id, 'starting', { detail: `第 ${entry.reconnectCount} 次自动重连（${entry.url}）` })
    // 陈旧的 ControlPath 遗留一并清理（死进程残留的 socket 会让 ssh 拒绝复用）。
    // 必须 await:否则可能删掉紧接着 spawn 的新 ssh 刚建立的 socket(评审 N3)
    await rm(entry.controlPath, { force: true }).catch(() => undefined)
    const instance = latestInstances.get(entry.id)
    if (!instance) {
      // 实例已被删除：停止隧道，不再重连
      entry.stopping = true
      entries.delete(entry.id)
      reservedPorts.delete(entry.localPort)
      if (entry.askpassServer) void entry.askpassServer.close().catch(() => undefined)
      entry.askpassServer = null
      emit(entry.id, 'stopped', { detail: '实例已删除' })
      return
    }
    // 端口转发失败（本地端口被占）→ 换一个本地端口再试
    if (entry.forwardFailed) {
      entry.forwardFailed = false
      reservedPorts.delete(entry.localPort)
      try {
        const port = await findFreePort({
          start: DEFAULT_PORT_RANGE_START,
          end: DEFAULT_PORT_RANGE_END,
          probe: portAvailabilityProbe
        })
        reservedPorts.add(port)
        if (entry.stopping) {
          // stop() 与换端口竞态:释放保留集,避免端口永久泄漏(评审 N2)
          reservedPorts.delete(port)
          return
        }
        entry.localPort = port
        entry.url = sshTunnelEndpoint(port)
        emit(entry.id, 'starting', { detail: `本地端口已重新分配为 ${port}` })
      } catch {
        // 无可用端口：按原端口再试一次（下次 forward 失败还会换）
      }
    }
    if (entry.stopping) return
    const child = spawnSsh(entry, instance)
    entry.child = child
    await waitForReady(entry)
  }

  function attachHandlers(child: SpawnedProcess, entry: TunnelEntry): void {
    const id = entry.id
    child.stdout?.on('data', (chunk: unknown) => pushLog(entry, chunk))
    child.stderr?.on('data', (chunk: unknown) => pushLog(entry, chunk))

    child.on('error', (error: Error) => {
      if (entries.get(id) !== entry || entry.child !== child) return
      if (entry.stopping) return
      entry.stopping = true
      emit(id, 'error', { detail: `SSH 进程启动失败：${error.message}` })
      entries.delete(id)
      reservedPorts.delete(entry.localPort)
      if (entry.askpassServer) void entry.askpassServer.close().catch(() => undefined)
      entry.askpassServer = null
    })

    child.on('exit', (code) => {
      if (entries.get(id) !== entry || entry.child !== child) return
      entry.child = null
      cancelReconnect(entry)
      if (entry.stopping) return // stop() 独占发布 stopped
      const attribution = entry.pendingReason ?? classifySshExit(code, entry.log.join('\n'))
      entry.pendingReason = null
      entry.ready = false
      // 稳定 ≥ 阈值后断线 → 退避重置（设计 §4.2：稳定 60s 重置）
      if (entry.stableSince !== null && now() - entry.stableSince >= stableResetMs) {
        entry.backoffMs = backoffBaseMs
      }
      entry.stableSince = null
      if (attribution.kind === 'forward') {
        // 端口冲突与远端状态无关：重连前换端口，且以基数立即重试
        entry.forwardFailed = true
        entry.backoffMs = backoffBaseMs
      }
      emit(id, 'error', {
        detail: `SSH 隧道断开（${attribution.message}）；${entry.backoffMs / 1000}s 后自动重连`
      })
      scheduleReconnect(entry)
    })
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
      if (entries.has(id) || startingIds.has(id)) {
        const existing = entries.get(id)
        if (existing) {
          if (!existing.ready && !existing.stopping && existing.child === null && !existing.reconnectScheduled) {
            // 自愈:看门狗链路断了(无子进程、无待重连)时,用户点「启动」应能恢复
            existing.backoffMs = backoffBaseMs
            emit(id, 'starting', { detail: '检测到隧道已中断，重新建立连接' })
            scheduleReconnect(existing)
            return
          }
          emit(id, existing.ready ? 'running' : 'starting', {
            ...(existing.url ? { url: existing.url } : {}),
            ...(existing.ready ? { port: existing.localPort } : {}),
            detail: '隧道已在运行，忽略重复启动'
          })
          return
        }
        emit(id, 'starting', { detail: '隧道正在启动，忽略重复启动' })
        return
      }
      startingIds.add(id)
      cancelRequested.delete(id)
      latestInstances.set(id, instance)
      try {
        emit(id, 'starting', { detail: '分配本地端口' })
        const localPort = await allocLocalPort(instance)
        if (cancelRequested.delete(id)) {
          reservedPorts.delete(localPort)
          emit(id, 'stopped', { detail: '已取消启动' })
          return
        }
        // known_hosts 落在 dataRoot/ssh（文件,无长度问题）;control socket 目录可能退化到 tmpdir
        await mkdir(join(dataRoot, 'ssh'), { recursive: true })
        await mkdir(socketsDirFor(dataRoot), { recursive: true })
        if (cancelRequested.delete(id)) {
          reservedPorts.delete(localPort)
          emit(id, 'stopped', { detail: '已取消启动' })
          return
        }
        const entry: TunnelEntry = {
          id,
          child: null,
          localPort,
          remoteLabel: `${instance.host}:${instance.remotePort}`,
          url: sshTunnelEndpoint(localPort),
          log: [],
          buffer: '',
          ready: false,
          stopping: false,
          reconnectScheduled: false,
          reconnectTimer: null,
          backoffMs: backoffBaseMs,
          stableSince: null,
          pendingReason: null,
          forwardFailed: false,
          reconnectCount: 0,
          askpassServer: null,
          askpassWrapperPath: null,
          // 短名 + 目标哈希:同一目标的多实例/多连接天然复用同一条主连接(ControlMaster=auto)
          controlPath: join(socketsDirFor(dataRoot), `ctl-${controlSlug(instance)}`)
        }
        emit(id, 'starting', { detail: '校验服务器指纹' })
        const trusted = await ensureTrust(instance, (detail) => emit(id, 'starting', { detail }))
        if (!trusted) {
          reservedPorts.delete(localPort)
          emit(id, 'error', { detail: '服务器指纹未确认（或已变化），已拒绝连接' })
          return
        }
        if (cancelRequested.delete(id)) {
          reservedPorts.delete(localPort)
          emit(id, 'stopped', { detail: '已取消启动' })
          return
        }
        // T5 askpass:口令提示通道(仅当接线了 askpass 时)
        entry.askpassServer = await startAskpassFor(entry).catch((error: unknown) => {
          console.error('[ssh-tunnel] askpass 通道启动失败：', error)
          return null
        })
        entries.set(id, entry)
        emit(id, 'starting', {
          detail: `建立 SSH 隧道（${localPort} → ${entry.remoteLabel}）`
        })
        // spawn 前清除可能残留的 ControlPath（重启场景）
        await rm(entry.controlPath, { force: true }).catch(() => undefined)
        const child = spawnSsh(entry, instance)
        entry.child = child
        await waitForReady(entry)
      } catch (error) {
        emit(id, 'error', {
          detail: error instanceof Error ? error.message : String(error)
        })
      } finally {
        startingIds.delete(id)
      }
    },

    async stop(id) {
      cancelRequested.add(id)
      latestInstances.delete(id)
      const entry = entries.get(id)
      if (!entry) {
        emit(id, 'stopped', { detail: '实例未在运行' })
        return
      }
      entry.stopping = true
      cancelReconnect(entry)
      const child = entry.child
      if (child) {
        killProcessGroup(child, 'SIGTERM')
        const exited = await waitForProcessExit(child, stopGraceMs)
        if (!exited) {
          killProcessGroup(child, 'SIGKILL')
          await waitForProcessExit(child, 1_000)
        }
      }
      entries.delete(id)
      reservedPorts.delete(entry.localPort)
      void rm(entry.controlPath, { force: true })
      if (entry.askpassServer) void entry.askpassServer.close().catch(() => undefined)
      entry.askpassServer = null
      emit(id, 'stopped', { detail: '隧道已停止' })
    },

    async stopAll() {
      const ids = [...entries.keys()]
      await Promise.all(ids.map((id) => this.stop(id)))
    }
  }
}