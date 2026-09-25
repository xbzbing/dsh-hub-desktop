/**
 * 主进程顶层失败的最后记录点：漏网的未处理拒绝与未捕获异常必须留痕。
 * 输出统一脱敏（URL 去掉查询串，避免 bearer token 进日志）；
 * 未捕获异常记录后退出，不带着不可信状态继续运行。
 */
import type { EventEmitter } from 'node:events'
import { redactLine } from '@shared/redact'

export interface TopLevelFailureDeps {
  /** 记录一行失败信息 */
  log: (line: string) => void
  /** 记录未捕获异常后的退出方式（宿主决定，Electron 侧为 app.exit） */
  exit: (code: number) => void
  /** 进程事件来源；缺省 process（测试注入 EventEmitter） */
  target?: EventEmitter
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return redactLine(reason.stack ?? reason.message)
  return redactLine(String(reason))
}

export function installTopLevelFailureLoggers(deps: TopLevelFailureDeps): void {
  const target = deps.target ?? process
  target.on('unhandledRejection', (reason: unknown) => {
    deps.log(`[main] 未处理的 Promise 拒绝：${describeReason(reason)}`)
  })
  target.on('uncaughtException', (error: unknown) => {
    deps.log(`[main] 未捕获的异常：${describeReason(error)}`)
    deps.exit(1)
  })
}
