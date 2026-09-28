/**
 * 临时调试：把窗口聚焦/显示相关事件追加到 `<userData>/focus-debug.log`，
 * 便于正常双击启动（stdout 被丢弃）的生产版也能留痕。复现定位后整体移除。
 */
import { app } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

let logPath: string | null = null

function resolvePath(): string | null {
  if (logPath) return logPath
  try {
    logPath = join(app.getPath('userData'), 'focus-debug.log')
    return logPath
  } catch {
    return null
  }
}

export function focusDebug(line: string): void {
  const message = `${new Date().toISOString()} ${line}`
  console.debug(message)
  const path = resolvePath()
  if (!path) return
  try {
    appendFileSync(path, `${message}\n`)
  } catch {
    // 调试日志失败绝不影响正常行为
  }
}
