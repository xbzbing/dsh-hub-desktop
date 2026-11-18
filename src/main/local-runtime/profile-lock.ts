/**
 * profile 写锁（`<profile>/package.json.lock`）的残留判定与清理。
 *
 * dsh 的 atomic-write 建锁分两步：先以 `O_CREAT|O_EXCL` 建文件，再写入持有者 PID。
 * 进程若正好在这两步之间被杀（实例重启、工具超时、强退），会留下 0 字节锁；其回收逻辑
 * 要求记录形如 `<pid>\n`，空记录永远不匹配，于是后来者只能等 `waitMs` 超时（web profile
 * 为 120 秒）——插件列表与安装全部失败，且重启应用不会自愈。
 *
 * 这里只做判定与移动（备份到 `<dataRoot>/stale-locks/`），不删除；持有者仍存活时绝不触碰。
 * 无 PID 记录的空锁要跨过 `EMPTY_LOCK_GRACE_MS` 才回收：「建文件 → 写 PID」之间的窗口只有
 * 微秒级，宽限避免把刚要写入 PID 的活锁挪走后出现两个写者。
 * 预检失败不得影响插件命令本身，调用方负责兜住异常。
 */
import { copyFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * 无 PID 记录（0 字节 / 形态不可解析）的锁的回收宽限期。
 * dsh 建锁是 `O_CREAT|O_EXCL` 建文件后立刻写 PID，两步之间只有微秒级窗口；2 秒足以覆盖
 * 调度抖动与慢磁盘，又不至于让真实残留锁多挡住用户两条命令。
 */
export const EMPTY_LOCK_GRACE_MS = 2_000

/** 一次预检的结论：锁不存在 / 被持有（含空锁仍在宽限期内）/ 已把残留锁挪走。 */
export type ProfileLockOutcome =
  | { state: 'absent' }
  | { state: 'held'; pid: number | null }
  | { state: 'cleared'; pid: number | null; movedTo: string }

export interface ProfileLockDeps {
  /** 读锁内容；文件不存在返回 null，其它读取错误照常抛出。 */
  read: (path: string) => Promise<string | null>
  /** 把残留锁移动到备份路径（跨卷时内部退化为复制 + 删源）。 */
  move: (from: string, to: string) => Promise<void>
  /** PID 是否仍存活；EPERM 视为存活（存在但不能信号）。 */
  isAlive: (pid: number) => boolean
  /** 锁文件距今的毫秒数（用 mtime 判断）；读不到（如 ENOENT）返回 null 表示判断不了。 */
  ageMs: (path: string) => Promise<number | null>
  /** 备份文件名里的时间戳片段（不含冒号，Windows 可用）。 */
  timestamp: () => string
}

/** 锁内容里的持有者 PID：正常写入形如 `<pid>\n`；空文件或其它形态返回 null。 */
export function parseLockPid(content: string): number | null {
  const match = /^\s*(\d+)\s*$/.exec(content)
  if (match === null) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/**
 * 按锁内容判断是否为可回收的残留锁：无 PID 记录（含 0 字节）或记录的进程已不存在。
 * 无 PID 的情形只说明「可能可回收」——真正的回收还要在 `clearStaleProfileLock` 里过
 * `EMPTY_LOCK_GRACE_MS` 宽限。返回 pid 便于调用方记录「哪个进程留下的」。
 */
export function staleLockPid(
  content: string,
  isAlive: (pid: number) => boolean
): {
  stale: boolean
  pid: number | null
} {
  const pid = parseLockPid(content)
  if (pid === null) return { stale: true, pid: null }
  return { stale: !isAlive(pid), pid }
}

function codesOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return codesOf(error) === 'EPERM'
  }
}

/** 移动文件所需的最小 fs 面（便于测试注入跨卷失败的 rename）。 */
interface MoveOps {
  rename: (from: string, to: string) => Promise<void>
  copyFile: (from: string, to: string) => Promise<void>
  unlink: (path: string) => Promise<void>
}

/**
 * 移动文件：`rename` 跨卷失败（EXDEV）时退化为复制后删除源文件。
 * 备份目录在 `<dataRoot>/stale-locks/`，实例 home（尤其公共空间的 `~/.dsh`）可能落在另一卷。
 */
export async function moveProfileLock(
  from: string,
  to: string,
  ops: MoveOps = { rename, copyFile, unlink }
): Promise<void> {
  try {
    await ops.rename(from, to)
  } catch (error) {
    // 其它错误（权限、目标已存在）照常抛给 guard：预检失败不阻塞命令。
    if (codesOf(error) !== 'EXDEV') throw error
    await ops.copyFile(from, to)
    await ops.unlink(from)
  }
}

/** 进程内默认依赖：只读真实文件，移动带跨卷兜底，存活判定走 signal 0。 */
export const DEFAULT_PROFILE_LOCK_DEPS: ProfileLockDeps = {
  read: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (codesOf(error) === 'ENOENT') return null
      throw error
    }
  },
  move: moveProfileLock,
  isAlive: defaultIsAlive,
  ageMs: async (path) => {
    try {
      return Date.now() - (await stat(path)).mtimeMs
    } catch {
      return null
    }
  },
  timestamp: () => new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * 清理一个残留锁：不存在返回 absent；持有进程存活、或空锁尚未过回收宽限时返回 held；
 * 其余挪走后返回 cleared。
 */
export async function clearStaleProfileLock(
  input: { lockPath: string; backupDir: string },
  deps: ProfileLockDeps = DEFAULT_PROFILE_LOCK_DEPS
): Promise<ProfileLockOutcome> {
  const content = await deps.read(input.lockPath)
  if (content === null) return { state: 'absent' }
  const { stale, pid } = staleLockPid(content, deps.isAlive)
  if (!stale) return { state: 'held', pid }
  // 无 PID 的锁可能是「刚建好、还没写 PID」的活锁：宽限内不动，让下一条命令再判断。
  // PID 已死的锁不必等 —— 它一定不会再有写者。
  if (pid === null) {
    const age = await deps.ageMs(input.lockPath)
    if (age === null || age < EMPTY_LOCK_GRACE_MS) return { state: 'held', pid: null }
  }
  await mkdir(input.backupDir, { recursive: true })
  // 备份名带原始文件名与时间戳：同一 profile 多次残留时不会互相覆盖，也便于事后判断来源。
  const movedTo = join(input.backupDir, `${basename(input.lockPath)}.${deps.timestamp()}`)
  await deps.move(input.lockPath, movedTo)
  return { state: 'cleared', pid, movedTo }
}

export interface ProfileLockGuard {
  /**
   * 执行插件命令前调用：把该实例 profile 的残留写锁挪到 `<dataRoot>/stale-locks/`。
   * 从不抛错——预检是尽力而为，命令本身仍按原样执行（真正的失败由命令结果决定）。
   */
  ensureClear(target: { home: string; profile: string }): Promise<ProfileLockOutcome | null>
}

export function createProfileLockGuard(options: {
  dataRoot: string
  deps?: ProfileLockDeps
  /** 挪走残留锁时记录一行便于排查的日志；缺省走 console.warn。 */
  onCleared?: (message: string) => void
}): ProfileLockGuard {
  const deps = options.deps ?? DEFAULT_PROFILE_LOCK_DEPS
  const onCleared =
    options.onCleared ??
    ((message: string): void => {
      console.warn(message)
    })

  return {
    async ensureClear({ home, profile }) {
      const lockPath = join(home, 'profiles', profile, 'package.json.lock')
      try {
        const outcome = await clearStaleProfileLock(
          { lockPath, backupDir: join(options.dataRoot, 'stale-locks') },
          deps
        )
        if (outcome.state === 'cleared') {
          const holder = outcome.pid === null ? 'no pid' : `pid ${outcome.pid}`
          onCleared(`[profile-lock] moved stale lock (${holder}) ${lockPath} -> ${outcome.movedTo}`)
        }
        return outcome
      } catch (error) {
        onCleared(`[profile-lock] preflight failed for ${lockPath}: ${String(error)}`)
        return null
      }
    }
  }
}
