import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROFILE_LOCK_DEPS,
  EMPTY_LOCK_GRACE_MS,
  clearStaleProfileLock,
  createProfileLockGuard,
  moveProfileLock,
  parseLockPid,
  staleLockPid
} from './profile-lock'
import type { ProfileLockDeps } from './profile-lock'

/**
 * profile 写锁的残留判定与清理。
 *
 * 守卫的核心约束只有三条：
 * - 只搬「没有 PID 记录且已过回收宽限」或「PID 已不存在」的锁，持有者还活着时绝不触碰；
 * - 空锁的宽限避免把「刚建文件、还没写 PID」的活锁挪走后出现两个写者；
 * - 预检本身永不抛错 —— 它是尽力而为，插件命令的成败仍由命令结果决定。
 */

/** 把锁文件的 mtime 回拨，模拟已经存在一段时间的残留锁。 */
async function ageLock(lockPath: string, ageMs = 10_000): Promise<void> {
  const past = new Date(Date.now() - ageMs)
  await utimes(lockPath, past, past)
}

/** 注入固定 mtime 年龄的依赖，避免依赖真实时钟与文件系统精度。 */
function depsAged(ageMs: number | null, overrides: Partial<ProfileLockDeps> = {}): ProfileLockDeps {
  return { ...DEFAULT_PROFILE_LOCK_DEPS, ageMs: async () => ageMs, ...overrides }
}

const dirs: string[] = []

/** 每个用例独立的临时根目录（用例结束统一删除）。 */
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'profile-lock-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 路径是否存在（不关心是文件还是目录）。 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('parseLockPid', () => {
  it('正常记录（<pid>\\n）取出 PID', () => {
    expect(parseLockPid('123\n')).toBe(123)
  })

  it('空记录、非数字与非正数一律视为无 PID', () => {
    expect(parseLockPid('')).toBeNull()
    expect(parseLockPid('abc')).toBeNull()
    expect(parseLockPid('0')).toBeNull()
    expect(parseLockPid('-1')).toBeNull()
  })
})

describe('staleLockPid', () => {
  it('没有 PID 记录的锁可回收（0 字节死锁）', () => {
    expect(staleLockPid('', () => true)).toEqual({ stale: true, pid: null })
  })

  it('持有进程仍存活时不回收', () => {
    expect(staleLockPid('4321\n', (pid) => pid === 4321)).toEqual({ stale: false, pid: 4321 })
  })

  it('持有进程已退出时可回收', () => {
    expect(staleLockPid('4321\n', () => false)).toEqual({ stale: true, pid: 4321 })
  })
})

describe('clearStaleProfileLock', () => {
  /** 临时 home 里的 profile 目录与其写锁、临时 dataRoot 下的备份目录。 */
  async function layout(): Promise<{ lockPath: string; backupDir: string }> {
    const root = await tempRoot()
    const profileDir = join(root, 'home', 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    return {
      lockPath: join(profileDir, 'package.json.lock'),
      backupDir: join(root, 'data', 'stale-locks')
    }
  }

  it('锁不存在：absent，不创建备份目录', async () => {
    const { lockPath, backupDir } = await layout()
    await expect(clearStaleProfileLock({ lockPath, backupDir })).resolves.toEqual({
      state: 'absent'
    })
    expect(await exists(backupDir)).toBe(false)
  })

  it('锁被存活进程持有：held，原文件与内容都不动', async () => {
    const { lockPath, backupDir } = await layout()
    await writeFile(lockPath, `${process.pid}\n`, 'utf8')
    await expect(clearStaleProfileLock({ lockPath, backupDir })).resolves.toEqual({
      state: 'held',
      pid: process.pid
    })
    expect(await readFile(lockPath, 'utf8')).toBe(`${process.pid}\n`)
    expect(await exists(backupDir)).toBe(false)
  })

  it('0 字节锁（已过宽限）：搬到备份目录，原文件消失且备份内容为空', async () => {
    const { lockPath, backupDir } = await layout()
    await writeFile(lockPath, '', 'utf8')
    // 0 字节锁要跨过回收宽限才会被回收，真实文件的新建 mtime 会落在宽限内。
    await ageLock(lockPath)

    const outcome = await clearStaleProfileLock({ lockPath, backupDir })

    expect(outcome.state).toBe('cleared')
    if (outcome.state !== 'cleared') return
    expect(outcome.pid).toBeNull()
    // 备份目录按需创建；备份名带原始文件名，便于事后判断来源。
    expect(dirname(outcome.movedTo)).toBe(backupDir)
    expect(basename(outcome.movedTo)).toContain('package.json.lock')
    expect(await exists(lockPath)).toBe(false)
    expect(await readFile(outcome.movedTo, 'utf8')).toBe('')
    expect(await readdir(backupDir)).toEqual([basename(outcome.movedTo)])
  })

  it('空锁仍在宽限内（500ms）：held，原文件不动', async () => {
    const { lockPath, backupDir } = await layout()
    await writeFile(lockPath, '', 'utf8')

    await expect(clearStaleProfileLock({ lockPath, backupDir }, depsAged(500))).resolves.toEqual({
      state: 'held',
      pid: null
    })
    expect(await exists(lockPath)).toBe(true)
    expect(await exists(backupDir)).toBe(false)
  })

  it('空锁超过宽限（5000ms）：cleared', async () => {
    const { lockPath, backupDir } = await layout()
    await writeFile(lockPath, '', 'utf8')

    const outcome = await clearStaleProfileLock({ lockPath, backupDir }, depsAged(5_000))

    expect(outcome.state).toBe('cleared')
    if (outcome.state !== 'cleared') return
    expect(outcome.pid).toBeNull()
    expect(await exists(lockPath)).toBe(false)
    expect(await readFile(outcome.movedTo, 'utf8')).toBe('')
  })

  it('空锁恰好到宽限边界：按已过期处理', async () => {
    const { lockPath, backupDir } = await layout()
    await writeFile(lockPath, '', 'utf8')

    await expect(
      clearStaleProfileLock({ lockPath, backupDir }, depsAged(EMPTY_LOCK_GRACE_MS))
    ).resolves.toMatchObject({ state: 'cleared' })
  })

  it('判不出 mtime（ageMs 返回 null）：按 held 处理，不清理', async () => {
    const { lockPath, backupDir } = await layout()
    await writeFile(lockPath, '', 'utf8')

    await expect(clearStaleProfileLock({ lockPath, backupDir }, depsAged(null))).resolves.toEqual({
      state: 'held',
      pid: null
    })
    expect(await exists(lockPath)).toBe(true)
    expect(await exists(backupDir)).toBe(false)
  })

  it('PID 已死的锁不受宽限影响：立即搬到备份目录并记录该 PID', async () => {
    const { lockPath, backupDir } = await layout()
    await writeFile(lockPath, '424242\n', 'utf8')

    // 即便年龄为 0（“刚刚”），已死的持有者不会再写锁，无需等宽限。
    const outcome = await clearStaleProfileLock(
      { lockPath, backupDir },
      depsAged(0, { isAlive: () => false })
    )

    expect(outcome.state).toBe('cleared')
    if (outcome.state !== 'cleared') return
    expect(outcome.pid).toBe(424242)
    expect(dirname(outcome.movedTo)).toBe(backupDir)
    expect(await exists(lockPath)).toBe(false)
    expect(await readFile(outcome.movedTo, 'utf8')).toBe('424242\n')
  })
})

describe('moveProfileLock', () => {
  it('rename 跨卷失败（EXDEV）→ 复制后删除源文件', async () => {
    const root = await tempRoot()
    const from = join(root, 'package.json.lock')
    const to = join(root, 'backup', 'package.json.lock')
    await mkdir(dirname(to), { recursive: true })
    await writeFile(from, '123\n', 'utf8')

    await moveProfileLock(from, to, {
      rename: async () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
      },
      copyFile,
      unlink
    })

    expect(await exists(from)).toBe(false)
    expect(await readFile(to, 'utf8')).toBe('123\n')
  })

  it('其它错误照常抛出，源文件保留', async () => {
    const root = await tempRoot()
    const from = join(root, 'package.json.lock')
    const to = join(root, 'backup', 'package.json.lock')
    await mkdir(dirname(to), { recursive: true })
    await writeFile(from, '123\n', 'utf8')

    await expect(
      moveProfileLock(from, to, {
        rename: async () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        },
        copyFile,
        unlink
      })
    ).rejects.toThrow('permission denied')
    expect(await exists(from)).toBe(true)
    expect(await exists(to)).toBe(false)
  })
})

describe('createProfileLockGuard', () => {
  it('按实例 home 推导锁路径，挪到 <dataRoot>/stale-locks/', async () => {
    const root = await tempRoot()
    const home = join(root, 'home')
    const dataRoot = join(root, 'data')
    const lockPath = join(home, 'profiles', 'web', 'package.json.lock')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(lockPath, '', 'utf8')
    // 刚写的空锁会落在回收宽限内；回拨 mtime 后才是一次真实的残留锁。
    await ageLock(lockPath)
    const messages: string[] = []
    const guard = createProfileLockGuard({
      dataRoot,
      onCleared: (message) => messages.push(message)
    })

    const outcome = await guard.ensureClear({ home, profile: 'web' })

    expect(outcome?.state).toBe('cleared')
    if (outcome?.state !== 'cleared') return
    expect(dirname(outcome.movedTo)).toBe(join(dataRoot, 'stale-locks'))
    expect(basename(outcome.movedTo)).toContain('package.json.lock')
    expect(await exists(lockPath)).toBe(false)
    expect(await readFile(outcome.movedTo, 'utf8')).toBe('')
    // 挪锁后留一行英文 warn：出问题时能凭日志定位到原锁与备份位置。
    expect(messages).toEqual([expect.stringContaining('moved stale lock (no pid)')])
    expect(messages[0]).toContain(lockPath)
  })

  it('读取锁出错时不抛错：返回 null 并记录预检失败', async () => {
    const root = await tempRoot()
    const home = join(root, 'home')
    const messages: string[] = []
    const guard = createProfileLockGuard({
      dataRoot: join(root, 'data'),
      deps: {
        ...DEFAULT_PROFILE_LOCK_DEPS,
        read: async () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        }
      },
      onCleared: (message) => messages.push(message)
    })

    await expect(guard.ensureClear({ home, profile: 'web' })).resolves.toBeNull()
    expect(messages).toEqual([expect.stringContaining('preflight failed')])
  })
})
