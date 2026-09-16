/**
 */
import { spawn } from 'node:child_process'

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

export const detachedSpawn: SpawnLike = ({ command, args, env, cwd, detached }) =>
  spawn(command, args, {
    env,
    cwd,
    detached,
    stdio: ['ignore', 'pipe', 'pipe']
  })

/** 杀整棵进程组（detached 启动 → 负 pid），失败退化为杀直接子进程 */
export function killProcessGroup(child: SpawnedProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* 已退出 */
    }
  }
}

/** 等待子进程退出；返回是否在超时内退出 */
export function waitForProcessExit(child: SpawnedProcess, timeoutMs: number): Promise<boolean> {
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
    child.on('exit', () => finish(true))
  })
}