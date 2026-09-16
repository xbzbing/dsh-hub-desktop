import { describe, expect, it } from 'vitest'
import {
  compareDshVersions,
  createPathProbe,
  planRuntimeSource,
  type PathRuntime
} from './runtime-source'
import type { CommandRunner } from './runtime-installer'

/**
 * #2 运行时获取策略(用户决策:「优先 hub 已装同版本 → 再探测 PATH →
 * 都没有才下载,真要下载时需要用户确认」)—— 纯决策函数穷举 + PATH 探测。
 */

const PATH_DSH: PathRuntime = { command: '/usr/local/bin/dsh', version: '0.1.5-rc.2' }

describe('planRuntimeSource(纯决策,全输入注入)', () => {
  // —— 固定版本(dshVersion = X)——

  it('固定 X + hub 已装 X → hub(第一优先)', () => {
    const plan = planRuntimeSource({
      desiredVersion: '0.1.5',
      hubInstalled: ['0.1.4', '0.1.5'],
      pathRuntime: PATH_DSH
    })
    expect(plan).toEqual({ kind: 'hub', version: '0.1.5', reason: 'pinned-installed' })
  })

  it('固定 X + hub 未装 + PATH dsh 恰为 X → path(第二优先)', () => {
    const plan = planRuntimeSource({
      desiredVersion: '0.1.5-rc.2',
      hubInstalled: ['0.1.4'],
      pathRuntime: PATH_DSH
    })
    expect(plan).toEqual({
      kind: 'path',
      command: '/usr/local/bin/dsh',
      version: '0.1.5-rc.2',
      reason: 'pinned-path-match'
    })
  })

  it('固定 X + hub 未装 + PATH dsh 版本不匹配 → download X(需确认)', () => {
    const plan = planRuntimeSource({
      desiredVersion: '0.1.5',
      hubInstalled: [],
      pathRuntime: PATH_DSH // 0.1.5-rc.2 ≠ 0.1.5,rc 不算同版本
    })
    expect(plan).toEqual({ kind: 'download', version: '0.1.5', reason: 'pinned-missing' })
  })

  it('固定 X + hub 未装 + 无 PATH → download X(需确认)', () => {
    const plan = planRuntimeSource({ desiredVersion: '0.1.5', hubInstalled: [], pathRuntime: null })
    expect(plan).toEqual({ kind: 'download', version: '0.1.5', reason: 'pinned-missing' })
  })

  // —— 未固定(dshVersion = null)——

  it('未固定 + 有 PATH dsh → path 优先(用户自己维护的安装,永远最新)', () => {
    const plan = planRuntimeSource({
      desiredVersion: null,
      hubInstalled: ['0.1.0'],
      pathRuntime: PATH_DSH
    })
    expect(plan).toEqual({
      kind: 'path',
      command: '/usr/local/bin/dsh',
      version: '0.1.5-rc.2',
      reason: 'unpinned-path-any'
    })
  })

  it('未固定 + 无 PATH + hub 已装 → hub 取最新(复用已下载)', () => {
    const plan = planRuntimeSource({
      desiredVersion: null,
      hubInstalled: ['0.1.9.0', '0.10.0', '0.9.0'],
      pathRuntime: null
    })
    // 数字感知:0.10.0 > 0.9.0 > 0.1.9.0(字典序会把 0.9 排最后,这里必须数字比较)
    expect(plan).toEqual({ kind: 'hub', version: '0.10.0', reason: 'unpinned-installed' })
  })

  it('未固定 + 无 PATH + hub 有正式与 rc → 取正式(0.1.5 > 0.1.5-rc.2)', () => {
    const plan = planRuntimeSource({
      desiredVersion: null,
      hubInstalled: ['0.1.5-rc.2', '0.1.5'],
      pathRuntime: null
    })
    expect(plan).toEqual({ kind: 'hub', version: '0.1.5', reason: 'unpinned-installed' })
  })

  it('未固定 + 无 PATH + hub 空 → download null(由调用方解析 latest,需确认)', () => {
    const plan = planRuntimeSource({ desiredVersion: null, hubInstalled: [], pathRuntime: null })
    expect(plan).toEqual({ kind: 'download', version: null, reason: 'unpinned-missing' })
  })

  it('未固定 + hub 只有 rc + 无 PATH → 取 rc(hub 里仅有就复用)', () => {
    const plan = planRuntimeSource({
      desiredVersion: null,
      hubInstalled: ['0.1.5-rc.2'],
      pathRuntime: null
    })
    expect(plan).toEqual({ kind: 'hub', version: '0.1.5-rc.2', reason: 'unpinned-installed' })
  })
})

describe('compareDshVersions(数字感知,正式 > 同号 rc)', () => {
  it.each([
    ['0.10.0', '0.9.0', 1], // 数字比较,非字典序
    ['0.9.0', '0.10.0', -1],
    ['0.1.5', '0.1.5-rc.2', 1], // 正式 > rc
    ['0.1.5-rc.2', '0.1.5', -1],
    ['0.1.5-rc.1', '0.1.5-rc.2', -1], // rc 后缀字典序
    ['1.2.3', '1.2.3', 0],
    ['0.1.0', '0.1.1', -1],
    ['2.0.0', '1.999.999', 1],
    ['0.1', '0.1.0', 0] // 段数不同,缺段按 0
  ])('compare(%s, %s) → %i', (a, b, expected) => {
    expect(Math.sign(compareDshVersions(a, b))).toBe(expected)
  })
})

/** 造一个按脚本应答的 CommandRunner:按 `command args.join` 前缀匹配 */
function scriptedRunner(script: Record<string, { code: number; stdout: string; stderr?: string }>): CommandRunner {
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(' ')
    // 先试全 key(含参数),再试命令本身
    const hit = script[key] ?? script[`${command} --version`] ?? script[command]
    if (!hit) {
      const error = new Error(`ENOENT: ${key}`) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    return { code: hit.code, stdout: hit.stdout, stderr: hit.stderr ?? '' }
  }
  return run
}

describe('createPathProbe(PATH 探测,尽力而为)', () => {
  it('which dsh → 绝对路径 + dsh --version → 有效版本 → 返回 {command, version}', async () => {
    const probe = createPathProbe({
      run: scriptedRunner({
        'which dsh': { code: 0, stdout: '/usr/local/bin/dsh\n' },
        '/usr/local/bin/dsh --version': { code: 0, stdout: '0.1.5-rc.2\n' }
      })
    })
    await expect(probe.probe()).resolves.toEqual({
      command: '/usr/local/bin/dsh',
      version: '0.1.5-rc.2'
    })
  })

  it('which 找不到(exit 1)→ null,不抛异常', async () => {
    const probe = createPathProbe({
      run: async () => ({ code: 1, stdout: '', stderr: 'not found' })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('which 抛 ENOENT(极端环境没有 which)→ null', async () => {
    const probe = createPathProbe({
      run: async () => {
        const error = new Error('ENOENT') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('which 输出相对路径 → 拒绝采用(PATH 里被塞相对路径时 spawn 行为随 cwd 漂移)', async () => {
    const probe = createPathProbe({
      run: scriptedRunner({
        'which dsh': { code: 0, stdout: 'bin/dsh\n' },
        'bin/dsh --version': { code: 0, stdout: '0.1.5\n' }
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('dsh --version 输出垃圾(不含合法版本字符集)→ null', async () => {
    const probe = createPathProbe({
      run: scriptedRunner({
        'which dsh': { code: 0, stdout: '/usr/local/bin/dsh\n' },
        '/usr/local/bin/dsh --version': { code: 0, stdout: 'not a version!!\n' }
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('dsh --version 非零退出 → null', async () => {
    const probe = createPathProbe({
      run: scriptedRunner({
        'which dsh': { code: 0, stdout: '/usr/local/bin/dsh\n' },
        '/usr/local/bin/dsh --version': { code: 127, stdout: '', stderr: 'command not found' }
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('--version 输出多行 → 取第一行(带尾随空白也容忍)', async () => {
    const probe = createPathProbe({
      run: scriptedRunner({
        'which dsh': { code: 0, stdout: '/Users/dev/.local/bin/dsh\n' },
        '/Users/dev/.local/bin/dsh --version': { code: 0, stdout: '0.1.5\nextra line\n' }
      })
    })
    await expect(probe.probe()).resolves.toEqual({
      command: '/Users/dev/.local/bin/dsh',
      version: '0.1.5'
    })
  })

  it('win32:用 where 探测,接受盘符绝对路径', async () => {
    const probe = createPathProbe({
      platform: 'win32',
      run: scriptedRunner({
        'where dsh': { code: 0, stdout: 'C:\\Tools\\dsh.exe\n' },
        'C:\\Tools\\dsh.exe --version': { code: 0, stdout: '0.1.5\r\n' }
      })
    })
    await expect(probe.probe()).resolves.toEqual({
      command: 'C:\\Tools\\dsh.exe',
      version: '0.1.5'
    })
  })

  it('win32:where 输出相对路径 → 拒绝', async () => {
    const probe = createPathProbe({
      platform: 'win32',
      run: scriptedRunner({
        'where dsh': { code: 0, stdout: 'dsh.exe\n' }
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })
})
