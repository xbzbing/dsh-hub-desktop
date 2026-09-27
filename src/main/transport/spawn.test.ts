import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { killProcessGroup, type KillDeps, type SpawnedProcess } from './spawn'

function fakeChild(pid: number | undefined): SpawnedProcess & { killCall: NodeJS.Signals[] } {
  const killCall: NodeJS.Signals[] = []
  return {
    pid,
    stdout: null,
    stderr: null,
    on: () => undefined,
    kill: ((signal?: NodeJS.Signals) => {
      killCall.push(signal ?? 'SIGTERM')
      return true
    }) as SpawnedProcess['kill'],
    killCall
  }
}

describe('killProcessGroup', () => {
  it('win32:走 taskkill /T /F 递归杀进程树,不用负 pid 信号', () => {
    const child = fakeChild(4321)
    const spawnKiller = vi.fn(() => new EventEmitter())
    killProcessGroup(child, 'SIGKILL', { platform: 'win32', spawnKiller })
    expect(spawnKiller).toHaveBeenCalledWith(4321)
    // win32 分支不应退化为直接 kill（taskkill 未报错时）
    expect(child.killCall).toEqual([])
  })

  it('win32:taskkill 启动报错 → 退化为直接杀子进程', () => {
    const child = fakeChild(4321)
    const emitter = new EventEmitter()
    const spawnKiller = vi.fn(() => emitter)
    killProcessGroup(child, 'SIGKILL', { platform: 'win32', spawnKiller })
    emitter.emit('error')
    expect(child.killCall).toEqual(['SIGKILL'])
  })

  it('pid 未知:直接返回,不尝试杀任何东西', () => {
    const child = fakeChild(undefined)
    const spawnKiller = vi.fn()
    killProcessGroup(child, 'SIGKILL', { platform: 'win32', spawnKiller })
    expect(spawnKiller).not.toHaveBeenCalled()
    expect(child.killCall).toEqual([])
  })

  it('posix:process.kill 抛错时退化为直接杀子进程', () => {
    const child = fakeChild(999999123)
    const deps: KillDeps = {
      platform: 'linux',
      spawnKiller: () => new EventEmitter()
    }
    // 该负 pid 几乎不可能对应真实进程组，process.kill 抛 ESRCH → 退化路径
    killProcessGroup(child, 'SIGTERM', deps)
    expect(child.killCall).toEqual(['SIGTERM'])
  })
})
