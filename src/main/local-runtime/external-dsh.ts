/**
 *
 * 用户场景:`dush` 给 dsh 打 patch 后手工常驻一个 dsh web
 *   node ~/.local/bin/dsh web --patch ~/.dush/cordis.dush.patch.yml --no-open
 * 于是「已经跑着的实例」既不被识别、也无法直接用视图打开。
 *
 * 本模块只做**只读探测**:`ps` 找 dsh web 进程，再由 `lsof` 确认该 PID 的监听端口。
 * 两个解析函数是纯函数(便于穷举测试),IO 全部可注入。
 */
import { execFile } from 'node:child_process'

/** 探测到的一个外部 dsh web 进程 */
export interface ExternalDshWeb {
  pid: number
  /** 监听端口;null = 未能确定(无 --port 且 lsof 未给出) */
  port: number | null
  /** `--patch <file>` 的取值(如 ~/.dush/cordis.dush.patch.yml);null = 未使用 patch */
  patch: string | null
  /** 原始命令行(已折叠空白并截断,仅供展示) */
  command: string
}

const PS_TIMEOUT_MS = 5_000
const LSOF_TIMEOUT_MS = 5_000
/** 展示用命令行的最大长度(避免 UI 被超长命令行撑破) */
const COMMAND_DISPLAY_MAX = 240

/**
 * 判断一行 `ps` 命令是否是我们关心的 dsh web。
 *
 * 必须同时满足:
 * - 脚本/可执行部分是 dsh(`/dsh`、`dsh.js`、`@deepseek-ai/dsh` 等形态);
 * - 紧跟其后有独立的 `web` 参数 —— hub 自己 spawn 的进程**没有** `web` 子命令
 *   (参数是 `--profile/--host/--port/--no-open`),因此天然被排除,不会把自己
 *   拉起的实例当成「外部实例」重复上报。
 */
export function isDshWebCommand(command: string): boolean {
  // 排除 shell / ps / grep 包装行:它们会把「dsh web」当参数,直接匹配会误报

  if (/^(?:bash|sh|zsh|fish|ps|grep|pgrep|rg)\b/.test(command)) return false
  if (/\bgrep\b|\bpgrep\b/.test(command)) return false
  if (!/dsh/i.test(command)) return false
  // dsh 脚本必须出现在**路径**里(`/…/dsh` 或 `dsh.js`),其后紧跟独立的 web 参数。
  // 这样 `grep dsh web`(dsh 前是空格/引号)不会命中,而
  // `node /Users/x/.local/bin/dsh web ...` 会命中。
  if (/\/dsh(?:\.js)?\s+web(?:\s|$)/i.test(command)) return true
  // node …/@deepseek-ai/dsh/lib/bin.js web …
  if (/@deepseek-ai\/dsh\b/.test(command) && /\/bin\.js\s+web(?:\s|$)/.test(command)) return true
  return false
}

/** 取 `--patch <v>` / `--patch=<v>` 的值;没有返回 null */
export function patchOf(command: string): string | null {
  const spaced = /(?:^|\s)--patch(?:=|\s+)(\S+)/.exec(command)
  if (spaced?.[1]) return spaced[1]
  return null
}

/** 取 `--port <v>` / `--port=<v>` 的值;没有/非法返回 null(端口还会由 lsof 兜底) */
export function portOf(command: string): number | null {
  const spaced = /(?:^|\s)--port(?:=|\s+)(\d{1,5})(?:\s|$)/.exec(command)
  const raw = spaced?.[1]
  if (!raw) return null
  const port = Number(raw)
  return port >= 1 && port <= 65_535 ? port : null
}

/**
 * 解析 `ps -axo pid=,command=` 输出。
 * 行格式:`<pid> <command...>`(pid 前可能有空白);无法解析的行直接跳过。
 */
export function parseDshWebProcesses(psOutput: string): ExternalDshWeb[] {
  const found: ExternalDshWeb[] = []
  const seen = new Set<number>()
  for (const rawLine of psOutput.split('\n')) {
    const trimmed = rawLine.trim()
    if (trimmed === '') continue
    const match = /^(\d+)\s+(.+)$/.exec(trimmed)
    if (!match) continue
    const pid = Number(match[1])
    const command = (match[2] ?? '').replace(/\s+/g, ' ').trim()
    if (seen.has(pid) || !isDshWebCommand(command)) continue
    seen.add(pid)
    found.push({
      pid,
      port: portOf(command),
      patch: patchOf(command),
      command: command.length > COMMAND_DISPLAY_MAX ? `${command.slice(0, COMMAND_DISPLAY_MAX)}…` : command
    })
  }
  return found
}

/**
 * 解析 `lsof -nP -iTCP -sTCP:LISTEN` 输出 → pid → 首个监听端口。
 * 行形如:`node 84758 dev 21u IPv4 0x… 0t0 TCP localhost:3080 (LISTEN)`。
 */
export function parseListeningPorts(lsofOutput: string): Map<number, number> {
  const ports = new Map<number, number>()
  for (const line of lsofOutput.split('\n')) {
    const match = /^\S+\s+(\d+)\s+.*\sTCP\s+.*?:(\d+)\s+\(LISTEN\)/.exec(line.trim())
    if (!match) continue
    const pid = Number(match[1])
    const port = Number(match[2])
    if (!Number.isInteger(pid) || port < 1 || port > 65_535) continue
    if (!ports.has(pid)) ports.set(pid, port)
  }
  return ports
}

export interface ExternalDshScannerOptions {
  /** 执行器注入(测试用);默认 execFile */
  run?: (command: string, args: string[]) => Promise<{ code: number; stdout: string }>
  platform?: NodeJS.Platform
}

export interface ExternalDshScanner {
  /** 扫描当前用户可见的 dsh web 进程(只读;失败返回空数组) */
  scan(): Promise<ExternalDshWeb[]>
}

export function createExternalDshScanner(
  options: ExternalDshScannerOptions = {}
): ExternalDshScanner {
  const platform = options.platform ?? process.platform
  const run =
    options.run ??
    ((command: string, args: string[]) =>
      new Promise<{ code: number; stdout: string }>((resolve, reject) => {
        // ps 与 lsof 各自的上限不同:lsof 列出所有监听 socket,给更宽裕的超时
        const timeout = command === 'lsof' ? LSOF_TIMEOUT_MS : PS_TIMEOUT_MS
        execFile(
          command,
          args,
          { timeout, maxBuffer: 1024 * 1024 },
          (error: Error | null, stdout: string | Buffer) => {
            if (error) {
              reject(error)
              return
            }
            resolve({ code: 0, stdout: String(stdout) })
          }
        )
      }))

  return {
    async scan(): Promise<ExternalDshWeb[]> {
      if (platform === 'win32') return [] // Windows 走 tasklist 分支待补,当前不误报
      let processes: ExternalDshWeb[]
      try {
        const ps = await run('ps', ['-axo', 'pid=,command='])
        processes = parseDshWebProcesses(ps.stdout)
      } catch {
        return []
      }
      if (processes.length === 0) return processes

      // 端口必须由该 PID 的监听 socket 确认。命令行 --port 仅作显示提示，不能证明
      // 进程仍成功绑定该端口，也不能证明该端口未被其他本机服务占用。
      try {
        const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
        const ports = parseListeningPorts(lsof.stdout)
        processes = processes.map((item) => ({ ...item, port: ports.get(item.pid) ?? null }))
      } catch {
        // lsof 不可用或超时时不返回可打开的端口，避免连接到未验证的本机服务。
        processes = processes.map((item) => ({ ...item, port: null }))
      }
      return processes
    }
  }
}
