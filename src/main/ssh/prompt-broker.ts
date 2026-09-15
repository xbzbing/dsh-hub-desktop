/**
 * 用户提示代理（T5）—— 不 import electron（由 main 注入发送函数）。
 *
 * 把主进程侧的「需要用户决策」请求（主机指纹确认、SSH 口令）转成渲染层对话框，
 * 并等待回答：
 * - 指纹确认：超时/无人应答 → 默认 **拒绝**（安全优先，绝不默认信任）；
 * - 口令：超时/无人应答 → 默认 **取消**（ssh 鉴权失败并由归因分类）。
 *
 * 口令只在内存中流转：不写盘、不写日志、不进审计。
 */
import { randomUUID } from 'node:crypto'
import type {
  AskpassPromptPayload,
  HostKeyDecision,
  HostKeyPromptPayload
} from '@shared/contracts'

export interface PromptBrokerOptions {
  /** 把请求投递给 hub 渲染窗口（多个窗口都要能收到，先到先答） */
  send: (channel: string, payload: unknown) => void
  hostKeyTimeoutMs?: number
  askpassTimeoutMs?: number
}

export interface PromptBroker {
  /** TOFU 指纹确认（tunnel manager 注入用） */
  requestHostKey(
    request: Omit<HostKeyPromptPayload, 'requestId'>
  ): Promise<HostKeyDecision>
  /** SSH 口令输入（tunnel manager 注入用）；null = 取消 */
  requestAskpass(request: Omit<AskpassPromptPayload, 'requestId'>): Promise<string | null>
  /** 渲染层回复（IPC 通道） */
  replyHostKey(requestId: string, decision: HostKeyDecision): boolean
  replyAskpass(requestId: string, secret: string | null): boolean
  /** 关闭窗口/退出时清空所有待答请求 */
  cancelAll(): void
}

interface Pending<T> {
  resolve: (value: T) => void
  timer: NodeJS.Timeout
}

export function createPromptBroker(options: PromptBrokerOptions): PromptBroker {
  const hostKeyTimeoutMs = options.hostKeyTimeoutMs ?? 5 * 60 * 1000
  const askpassTimeoutMs = options.askpassTimeoutMs ?? 10 * 60 * 1000
  const pendingHostKeys = new Map<string, Pending<HostKeyDecision>>()
  const pendingAskpass = new Map<string, Pending<string | null>>()

  return {
    requestHostKey(request) {
      const requestId = randomUUID()
      return new Promise<HostKeyDecision>((resolve) => {
        const timer = setTimeout(() => {
          pendingHostKeys.delete(requestId)
          resolve('reject') // 无人确认 = 不信任
        }, hostKeyTimeoutMs)
        timer.unref?.()
        pendingHostKeys.set(requestId, { resolve, timer })
        options.send('ssh:hostKeyDecision', { ...request, requestId })
      })
    },

    requestAskpass(request) {
      const requestId = randomUUID()
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          pendingAskpass.delete(requestId)
          resolve(null) // 超时 = 取消
        }, askpassTimeoutMs)
        timer.unref?.()
        pendingAskpass.set(requestId, { resolve, timer })
        options.send('ssh:askpassRequest', { ...request, requestId })
      })
    },

    replyHostKey(requestId, decision) {
      const entry = pendingHostKeys.get(requestId)
      if (!entry) return false
      pendingHostKeys.delete(requestId)
      clearTimeout(entry.timer)
      entry.resolve(decision === 'trust' ? 'trust' : 'reject')
      return true
    },

    replyAskpass(requestId, secret) {
      const entry = pendingAskpass.get(requestId)
      if (!entry) return false
      pendingAskpass.delete(requestId)
      clearTimeout(entry.timer)
      entry.resolve(typeof secret === 'string' ? secret : null)
      return true
    },

    cancelAll() {
      for (const [requestId, entry] of pendingHostKeys) {
        clearTimeout(entry.timer)
        entry.resolve('reject')
        pendingHostKeys.delete(requestId)
      }
      for (const [requestId, entry] of pendingAskpass) {
        clearTimeout(entry.timer)
        entry.resolve(null)
        pendingAskpass.delete(requestId)
      }
    }
  }
}