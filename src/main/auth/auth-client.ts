/**
 * AuthClient（T7,设计文档 §5.3/§5.4）—— 每实例一个:状态机 + 网关客户端 + 退避 + Cookie 罐。
 *
 * 职责(不 import electron):
 * - `probeAndRestore()`:识别网关(302→/login、401 unauthenticated)并**优先静默恢复**
 *   (带已存 Cookie 打 `GET /login-api/settings` = 200 → 直接 connected,不打扰用户);
 * - `login(password)`:提交密码;400 otp-required → 进入验证码阶段;200 → connected;
 * - `submitOtp(otp)` / `submitBackupCode(code)`:验证码阶段提交(同一次请求带码优先);
 * - `logout()`:清 Cookie 并回到 needs-auth;
 * - 429(rate-limited / too-many-attempts):以 `retryAfterSeconds` 为唯一计时依据,
 *   锁定期间 `canSubmit()` 为 false(UI 据此显示倒计时并禁用提交);
 * - 凭据纪律:密码/验证码只在内存中停留,不落盘、不写日志。
 */
import { createBackoff, type BackoffController } from './backoff'
import { createGatewayClient, type GatewayClient, type GatewayResult } from './gateway-client'
import { createCookieJar, type CookieJar } from './cookie-jar'
import {
  canSubmit,
  canSubmitOtp,
  eventFromFailure,
  initialState,
  type AuthState,
  transition
} from './gateway-state'
import type { HttpAuthDetection } from '@shared/contracts'
import { detectAuthMode } from './detect'

type AuthDetection = HttpAuthDetection

export interface AuthClientOptions {
  instanceId: string
  /** 归一化端点(含 basePath),如 https://gw.example.com/dsh */
  endpointUrl: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** 注入既有 Cookie 罐(跨启动复用/测试) */
  jar?: CookieJar
  now?: () => number
  /** 状态变化通知(UI 订阅点) */
  onState?: (state: AuthState) => void
}

export interface AuthClient {
  readonly instanceId: string
  readonly jar: CookieJar
  readonly backoff: BackoffController
  state(): AuthState
  /** 探测端点并尝试静默恢复;返回探测结论(用于 UI 文案与 T6 detect 复用) */
  probeAndRestore(): Promise<AuthDetection>
  /** 提交密码(可同时带验证码完成单请求 2FA) */
  login(password: string, otp?: string): Promise<AuthState>
  submitOtp(otp: string): Promise<AuthState>
  submitBackupCode(code: string): Promise<AuthState>
  logout(): Promise<AuthState>
  /** 是否持有会话 Cookie(不代表服务端仍有效) */
  hasSession(): boolean
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const gateway: GatewayClient = createGatewayClient({
    baseUrl: options.endpointUrl,
    jar: options.jar ?? createCookieJar(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  })
  const backoff = createBackoff(options.now ? { now: options.now } : {})
  let state = initialState()

  function publish(next: AuthState): AuthState {
    state = next
    options.onState?.(next)
    return next
  }

  function apply(event: Parameters<typeof transition>[1]): AuthState {
    const result = transition(state, event)
    return publish(result.state)
  }

  /** 429/锁定:记录退避并把状态推进到锁定展示 */
  function handleFailure(failure: Extract<GatewayResult<unknown>, { ok: false }>): AuthState {
    if (failure.code === 'rate-limited' || failure.code === 'too-many-attempts') {
      backoff.recordRateLimited(failure.retryAfterSeconds, failure.message)
    }
    return apply(eventFromFailure(failure))
  }

  return {
    instanceId: options.instanceId,
    jar: gateway.jar,
    backoff,
    state: () => state,
    hasSession: () => gateway.hasSession(),

    async probeAndRestore() {
      apply({ type: 'probe-started' })
      // 1) 会话静默恢复:带已有 Cookie 试 settings
      if (gateway.hasSession()) {
        const settings = await gateway.settings()
        if (settings.ok) {
          apply({ type: 'session-restored', otpEnabled: settings.value.otpEnabled })
          return {
            mode: 'gateway',
            gatewayEvidence: 'api-401',
            evidence: '已存会话有效（静默恢复）',
            status: 200,
            at: new Date().toISOString()
          }
        }
        if (!settings.ok && settings.status === 401) {
          // 会话失效:继续探测是否需要登录
          gateway.jar.clear()
        }
      }
      // 2) 探测端点:302→/login 或 401 unauthenticated = 网关
      const detection = await detectEndpoint(options.endpointUrl, options)
      switch (detection.mode) {
        case 'gateway':
          apply({ type: 'probe-gateway' })
          apply({ type: 'session-absent' })
          break
        case 'none':
        case 'browser-auth':
          // 无需网关登录:直接视为可连接(浏览器认证由 webview 自认证,§6.5)
          apply({ type: 'session-restored', otpEnabled: false })
          break
        default:
          apply({ type: 'probe-unreachable', message: detection.evidence })
      }
      return detection
    },

    async login(password, otp) {
      if (!backoff.canAttempt() || !canSubmit(state)) return state
      const result = await gateway.login({ password, ...(otp === undefined ? {} : { otp }) })
      if (result.ok) {
        backoff.recordSuccess()
        return apply({ type: 'login-succeeded', usedOtp: otp !== undefined })
      }
      return handleFailure(result)
    },

    async submitOtp(otp) {
      if (!backoff.canAttempt() || !canSubmitOtp(state)) return state
      // 已有会话(补验路径)优先走 /otp/verify;否则用「密码未知」场景由调用方走 login
      if (gateway.hasSession()) {
        const result = await gateway.verifyOtp(otp)
        if (result.ok) {
          backoff.recordSuccess()
          return apply({ type: 'login-succeeded', usedOtp: true })
        }
        return handleFailure(result)
      }
      return state
    },

    async submitBackupCode(code) {
      if (!backoff.canAttempt() || !canSubmitOtp(state)) return state
      if (gateway.hasSession()) {
        const result = await gateway.verifyBackupCode(code)
        if (result.ok) {
          backoff.recordSuccess()
          return apply({ type: 'login-succeeded', usedOtp: true })
        }
        return handleFailure(result)
      }
      return state
    },

    async logout() {
      const result = await gateway.logout()
      backoff.recordSuccess()
      if (!result.ok && result.code !== 'unauthenticated') {
        // 登出失败也清本地会话(用户意图明确)
        return apply({ type: 'session-absent' })
      }
      return apply({ type: 'session-absent' })
    }
  }
}

/** 探测封装(§2.3 判定复用 T6 的 detect,避免两套判定漂移) */
async function detectEndpoint(
  endpointUrl: string,
  options: AuthClientOptions
): Promise<AuthDetection> {
  return detectAuthMode(`${endpointUrl.replace(/\/+$/, '')}/`, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  })
}

export type { AuthState }
