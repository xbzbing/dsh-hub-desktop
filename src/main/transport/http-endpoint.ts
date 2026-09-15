/**
 * HTTP 直连传输（T6,设计文档 §2.3/§4.3）—— 不 import electron。
 *
 * 远程实例没有本地进程可管：`start` = 校验端点 → §4.3 健康探测 → §2.3 认证模式探测
 * → 发布 running（携带探测结论）；`stop` = 发布 stopped（无进程回收）。
 * 探测结论供 UI 展示与 T7 登录状态机使用；真实登录在 T7。
 */
import type { HttpInstance, InstanceRuntimeStatus, InstanceStatusEvent } from '@shared/contracts'
import { parseEndpointUrl } from '@shared/endpoint'
import { detectAuthMode, type AuthDetection } from '../auth/detect'
import { httpDirectEndpoint } from './endpoint-resolver'
import { httpHealthProbe, sleep, type HealthProbe } from './probe'

export interface HttpEndpointOptions {
  probe?: HealthProbe
  detect?: (url: string) => Promise<AuthDetection>
  healthTimeoutMs?: number
  /** 连接期探测重试（§4.3:500ms） */
  healthProbeRetries?: number
  healthProbeRetryMs?: number
  now?: () => number
}

export interface HttpEndpointManager {
  onStatus(listener: (event: InstanceStatusEvent) => void): () => void
  statusOf(id: string): InstanceStatusEvent | null
  runningIds(): string[]
  /** 立即返回；进展经 onStatus 推进（与 IPC 契约一致） */
  start(instance: HttpInstance): Promise<void>
  stop(id: string): Promise<void>
  stopAll(): Promise<void>
}

interface Entry {
  id: string
  url: string
  detection: AuthDetection | null
  stopping: boolean
}

export function createHttpEndpoints(options: HttpEndpointOptions = {}): HttpEndpointManager {
  const probe = options.probe ?? httpHealthProbe
  const detect = options.detect ?? ((url: string) => detectAuthMode(url))
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  const healthProbeRetries = options.healthProbeRetries ?? 3
  const healthProbeRetryMs = options.healthProbeRetryMs ?? 500
  const now = options.now ?? (() => Date.now())

  const entries = new Map<string, Entry>()
  const statuses = new Map<string, InstanceStatusEvent>()
  const listeners = new Set<(event: InstanceStatusEvent) => void>()
  const startingIds = new Set<string>()

  function emit(id: string, status: InstanceRuntimeStatus, extra: Partial<InstanceStatusEvent> = {}): void {
    const event: InstanceStatusEvent = { id, status, at: new Date(now()).toISOString(), ...extra }
    statuses.set(id, event)
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[http-endpoint] 状态监听器抛错：', error)
      }
    }
  }

  /** 探测结论 → 面向用户的一句话（不含凭据） */
  function detectionDetail(detection: AuthDetection): string {
    switch (detection.mode) {
      case 'gateway':
        return `检测到登录认证（${detection.evidence}）`
      case 'browser-auth':
        return '检测到 dsh 内置浏览器认证（页面内自认证）'
      case 'none':
        return '无需登录认证，可直接访问'
      default:
        return detection.evidence
    }
  }

  return {
    onStatus(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    statusOf(id) {
      return statuses.get(id) ?? null
    },

    runningIds() {
      return [...entries.keys()]
    },

    async start(instance) {
      const id = instance.id
      if (entries.has(id) || startingIds.has(id)) {
        const existing = entries.get(id)
        emit(id, 'running', {
          ...(existing ? { url: existing.url, detail: '实例已在运行，忽略重复启动' } : { detail: '实例正在启动，忽略重复启动' })
        })
        return
      }
      startingIds.add(id)
      try {
        // 端点校验（复用 shared/endpoint.ts；不合法直接报错,不进入探测）
        const url = httpDirectEndpoint(instance)
        const entry: Entry = { id, url, detection: null, stopping: false }
        entries.set(id, entry)
        emit(id, 'starting', { detail: `校验端点 ${url}` })

        // §4.3 健康探测:任意 HTTP 响应即传输就绪
        let healthy = false
        for (let attempt = 1; attempt <= healthProbeRetries; attempt++) {
          if (entry.stopping) return
          healthy = await probe(url, healthTimeoutMs)
          if (healthy) break
          if (attempt < healthProbeRetries) await sleep(healthProbeRetryMs)
        }
        if (entry.stopping) return
        if (!healthy) {
          entries.delete(id)
          emit(id, 'error', { detail: `端点不可达：${url}（连接被拒或超时）`, url })
          return
        }

        // §2.3 认证模式探测（用户显式指定时跳过）
        let detection: AuthDetection | null = null
        if (instance.authMode === 'auto') {
          emit(id, 'starting', { url, detail: '探测认证模式' })
          detection = await detect(url)
          entry.detection = detection
        }
        if (entry.stopping) return
        emit(id, 'running', {
          url,
          detail:
            instance.authMode === 'auto' && detection
              ? detectionDetail(detection)
              : instance.authMode === 'none'
                ? '按配置跳过登录认证'
                : '按配置使用网关登录（T7 接入）'
        })
      } catch (error) {
        entries.delete(id)
        emit(id, 'error', {
          detail: error instanceof Error ? error.message : String(error)
        })
      } finally {
        startingIds.delete(id)
      }
    },

    async stop(id) {
      const entry = entries.get(id)
      if (!entry) {
        emit(id, 'stopped', { detail: '实例未在运行' })
        return
      }
      entry.stopping = true
      entries.delete(id)
      emit(id, 'stopped', { detail: '已停止' })
    },

    async stopAll() {
      const ids = [...entries.keys()]
      await Promise.all(ids.map((id) => this.stop(id)))
    }
  }
}

/** 供向导 Step3 urlDetect 复用的只读探测（不建立实例、不写注册表） */
export async function detectDraftEndpoint(rawUrl: string): Promise<AuthDetection> {
  const normalized = parseEndpointUrl(rawUrl) // 非法输入在此抛出,由 IPC 边界转 invalid-input
  return detectAuthMode(`${normalized.baseUrl}/`)
}
