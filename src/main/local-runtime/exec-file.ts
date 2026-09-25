/**
 * 本机子进程的统一执行与退出码映射。映射口径只此一份，避免各调用点分歧：
 * - 启动失败（`error.code` 为字符串错误码，如 ENOENT / EACCES）→ reject
 * - 超时或被信号终止（`killed` / `signal`）→ reject，绝不折算成 `code: 0` 成功
 * - 正常退出（含非零退出码）→ resolve，由调用方按退出码判断成败
 */
import { execFile } from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv }
) => Promise<CommandResult>

/** 执行 `command args` 并按上述口径映射结果。 */
export function execFileResult(
  command: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const errCode = (error as NodeJS.ErrnoException).code
        if (typeof errCode === 'string') {
          reject(error)
          return
        }
        if (error.killed || error.signal != null) {
          reject(error)
          return
        }
        resolve({
          code: typeof errCode === 'number' ? errCode : 1,
          stdout: String(stdout),
          stderr: String(stderr)
        })
        return
      }
      resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}
