/**
 * 登录状态机（T7,设计文档 §5.3）—— 不 import electron。
 *
 * 状态(判别联合,与设计图一一对应):
 *   unknown → probe → needs-auth → { connected | await-credentials | await-otp | error }
 * - `needs-auth`:识别为网关(302→/login 或 401 unauthenticated);
 * - 已存 Cookie 有效 → 静默恢复到 `connected`(GET /login-api/settings = 200);
 * - **G2 已决边**:钥匙串里有该实例密码 → 从 needs-auth **直达 await-otp**(密码静默提交,
 *   不经过 UI);统一 401 则回退 await-credentials(不暴露是密码错还是码错);
 * - 429:进入锁定倒计时(`retryAfterSeconds` 为唯一计时依据),期间禁止发请求;
 * - 分步(password → otp → backup)是唯一 UI 形态,不做密码+验证码同屏。
 */
import type { GatewayFailure } from './gateway-client'

export type AuthPhase =
  | 'unknown' // 初始化
  | 'probe' // 探测中
  | 'needs-auth' // 已识别为网关,需要认证
  | 'await-credentials' // 等待用户输入密码
  | 'await-otp' // 等待动态验证码 / 备份码
  | 'connected' // 会话就绪
  | 'error' // 传输未就绪 / 失败超限

export interface AuthState {
  phase: AuthPhase
  /** 是否需要 onboarding(改初始密码) */
  needsOnboarding: boolean
  /** 二因素是否启用(来自 settings,用于 UI 展示) */
  otpEnabled: boolean
  /** 锁定倒计时(ms);>0 时禁止发认证请求 */
  lockedForMs: number
  /** 面向用户的提示(不含凭据) */
  message: string | null
  /** 最近一次失败码(UI 归类用) */
  lastErrorCode: string | null
}

export function initialState(): AuthState {
  return {
    phase: 'unknown',
    needsOnboarding: false,
    otpEnabled: false,
    lockedForMs: 0,
    message: null,
    lastErrorCode: null
  }
}

/** 状态机可接受的事件 */
export type AuthEvent =
  | { type: 'probe-started' }
  | { type: 'probe-gateway' } // 302→/login 或 401 unauthenticated
  | { type: 'probe-unreachable'; message: string }
  | { type: 'session-restored'; otpEnabled: boolean } // 带 Cookie settings=200
  | { type: 'session-absent' } // 无 Cookie / 401
  | { type: 'stored-password-available' } // G2:钥匙串里有密码 → 直达 await-otp
  | { type: 'login-succeeded'; usedOtp: boolean }
  | { type: 'login-requires-otp'; otpEnabled: boolean } // 400 otp-required
  | { type: 'credentials-rejected' } // 401 invalid-credentials(统一)
  | { type: 'rate-limited'; retryAfterSeconds: number | null; message: string }
  | { type: 'lock-tick'; remainingMs: number } // 倒计时刷新(只改展示)
  | { type: 'onboarding-required' }
  | { type: 'failed'; message: string; code?: string }
  | { type: 'reset' }

export interface AuthTransition {
  state: AuthState
  /** 状态机建议的动作(由调用方执行;状态机本身不做 IO) */
  action: 'none' | 'probe' | 'submit-password' | 'prompt-credentials' | 'prompt-otp' | 'ready' | 'stop'
}

/** 由失败结果推导事件(把网关错误码收敛为状态机事件) */
export function eventFromFailure(failure: GatewayFailure): AuthEvent {
  switch (failure.code) {
    case 'otp-required':
      return { type: 'login-requires-otp', otpEnabled: true }
    case 'invalid-credentials':
    case 'invalid-otp':
    case 'invalid-backup-code':
      return { type: 'credentials-rejected' }
    case 'rate-limited':
    case 'too-many-attempts':
      return {
        type: 'rate-limited',
        retryAfterSeconds: failure.retryAfterSeconds,
        message: failure.message
      }
    case 'onboarding-required':
      return { type: 'onboarding-required' }
    case 'unauthenticated':
      return { type: 'session-absent' }
    default:
      return { type: 'failed', message: failure.message, code: failure.code }
  }
}

export function transition(state: AuthState, event: AuthEvent): AuthTransition {
  switch (event.type) {
    case 'reset':
      return { state: initialState(), action: 'none' }

    case 'probe-started':
      return { state: { ...state, phase: 'probe', message: null }, action: 'probe' }

    case 'probe-gateway':
      return {
        state: { ...state, phase: 'needs-auth', message: null },
        action: 'none'
      }

    case 'probe-unreachable':
      return {
        state: { ...state, phase: 'error', message: event.message, lastErrorCode: 'network' },
        action: 'stop'
      }

    case 'session-restored':
      return {
        state: {
          ...state,
          phase: 'connected',
          otpEnabled: event.otpEnabled,
          needsOnboarding: false,
          lockedForMs: 0,
          message: null,
          lastErrorCode: null
        },
        action: 'ready'
      }

    case 'session-absent':
      // 探测为网关且无有效会话 → 直接进入「等待凭据」(设计 §5.3 的 NEEDS_AUTH→AWAIT_CREDENTIALS 边)
      return {
        state: {
          ...state,
          phase: state.phase === 'needs-auth' ? 'await-credentials' : 'needs-auth',
          message: null,
          lastErrorCode: null
        },
        action: 'none'
      }

    case 'stored-password-available':
      // G2:已存密码 → 跳过密码屏,密码静默提交(UI 只等验证码)
      // 【T8 评审-2 决议】此边**保留为设计记录,生产不派发**:静默登录由 IPC 层等效
      // 实现(register.ts 的 probe auto-try + auth:loginStored,密码不跨 IPC 且有
      // vault 双门禁/一次性记账/登出压制)。原因:探测终态固定是 await-credentials
      // (见上方 session-absent 边),needs-auth 只是首探瞬间相,本边的触发前提在
      // probe 链路上不存在;接第二个派发方只会造成双轨漂移,删除则动 T7 已锁定的
      // 状态机测试面。
      if (state.phase !== 'needs-auth') return { state, action: 'none' }
      return {
        state: { ...state, phase: 'await-otp', message: null },
        action: 'submit-password'
      }

    case 'login-succeeded':
      return {
        state: {
          ...state,
          phase: 'connected',
          lockedForMs: 0,
          message: null,
          lastErrorCode: null,
          otpEnabled: event.usedOtp ? true : state.otpEnabled
        },
        action: 'ready'
      }

    case 'login-requires-otp':
      return {
        state: {
          ...state,
          phase: 'await-otp',
          otpEnabled: event.otpEnabled,
          message: null,
          lastErrorCode: null
        },
        action: 'prompt-otp'
      }

    case 'credentials-rejected':
      // 统一 401:不区分密码错/码错;从 await-otp 回退密码屏(设计 §5.3)
      return {
        state: {
          ...state,
          phase: state.phase === 'await-otp' ? 'await-credentials' : state.phase,
          lastErrorCode: 'invalid-credentials',
          message: '账号或验证码错误'
        },
        action: state.phase === 'await-otp' ? 'prompt-credentials' : 'none'
      }

    case 'rate-limited':
      return {
        state: {
          ...state,
          // 锁定期间保持当前输入阶段(倒计时结束后可重试)
          lockedForMs:
            typeof event.retryAfterSeconds === 'number' && event.retryAfterSeconds > 0
              ? event.retryAfterSeconds * 1000
              : retryFloorMs,
          lastErrorCode: event.retryAfterSeconds ? 'too-many-attempts' : 'rate-limited',
          message: event.message
        },
        action: 'none'
      }

    case 'lock-tick':
      return { state: { ...state, lockedForMs: Math.max(0, event.remainingMs) }, action: 'none' }

    case 'onboarding-required':
      return {
        state: {
          ...state,
          needsOnboarding: true,
          phase: 'await-credentials',
          lastErrorCode: 'onboarding-required',
          message: '该实例需要先设置新的登录密码'
        },
        action: 'prompt-credentials'
      }

    case 'failed':
      return {
        state: {
          ...state,
          phase: 'error',
          message: event.message,
          lastErrorCode: event.code ?? 'unexpected'
        },
        action: 'stop'
      }

    default:
      return { state, action: 'none' }
  }
}

/** 无 retryAfterSeconds 时的最短锁定(设计:≥30s) */
export const retryFloorMs = 30_000

/** 是否允许发起认证请求(锁定期间禁止;needs-auth 亦可直接提交,UI 不必先切阶段) */
export function canSubmit(state: AuthState): boolean {
  if (state.lockedForMs > 0) return false
  return (
    state.phase === 'needs-auth' ||
    state.phase === 'await-credentials' ||
    state.phase === 'await-otp'
  )
}

/** 是否允许在「验证码阶段」提交(密码已有、只差码) */
export function canSubmitOtp(state: AuthState): boolean {
  return state.lockedForMs <= 0 && (state.phase === 'needs-auth' || state.phase === 'await-otp')
}
