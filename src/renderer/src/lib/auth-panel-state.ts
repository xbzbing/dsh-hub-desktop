/**
 * 认证面板的状态归约。保持为纯函数，便于测试。
 *
 * 事件仅更新对应实例的面板；锁定时长会换算为绝对到期时刻，
 * 以便按当前时间派生倒计时。
 */
import type { AuthStateEvent, AuthStateSnapshot } from '@shared/contracts'

export interface AuthPanelTarget {
  id: string
  name: string
}

export interface AuthPanelModel {
  /** 面板指向的实例;null 表示面板关闭 */
  target: AuthPanelTarget | null
  state: AuthStateSnapshot | null
  /** 锁定到期时刻(epoch ms);null 表示未锁定 */
  lockUntil: number | null
}

export const initialAuthPanelModel: AuthPanelModel = {
  target: null,
  state: null,
  lockUntil: null
}

/** 打开面板(详情页/浮层触发) */
export function openAuthPanel(
  model: AuthPanelModel,
  target: AuthPanelTarget
): AuthPanelModel {
  return { ...model, target, state: model.target?.id === target.id ? model.state : null }
}

/** 关闭面板并清空锁定 */
export function closeAuthPanel(): AuthPanelModel {
  return initialAuthPanelModel
}

/**
 * 归约一次 `auth:state` 事件。
 * - 面板关闭 → 忽略(不因他人事件自动弹面板)
 * - 事件属于其它实例 → 忽略(串台防线)
 * - `connected` → 关闭面板
 */
export function applyAuthState(
  model: AuthPanelModel,
  event: AuthStateEvent,
  now: number = Date.now()
): AuthPanelModel {
  const target = model.target
  if (!target) return model
  if (event.instanceId !== target.id) return model

  if (event.state.phase === 'connected') return closeAuthPanel()

  return {
    target,
    state: event.state,
    lockUntil:
      event.state.lockedForMs > 0 ? now + event.state.lockedForMs : null
  }
}

/** 登录/探测返回的快照也走同一归约(便于统一锁定换算) */
export function applyAuthSnapshot(
  model: AuthPanelModel,
  instanceId: string,
  state: AuthStateSnapshot,
  now: number = Date.now()
): AuthPanelModel {
  return applyAuthState(model, { instanceId, state, at: new Date(now).toISOString() }, now)
}

/**
 * 清除锁定态。到期后即使探测失败也必须解除锁定，允许用户再次提交。
 */
export function clearLock(model: AuthPanelModel): AuthPanelModel {
  if (model.lockUntil === null) return model
  return { ...model, lockUntil: null }
}

/** 锁定剩余毫秒(按 deadline 派生,倒计时会走动) */
export function lockRemaining(model: AuthPanelModel, now: number = Date.now()): number {
  if (model.lockUntil === null) return 0
  return Math.max(0, model.lockUntil - now)
}

/** 锁定是否已到期(到期后应重探以刷新状态与按钮可用性) */
export function lockExpired(model: AuthPanelModel, now: number = Date.now()): boolean {
  return model.lockUntil !== null && model.lockUntil <= now
}

/** 锁定剩余秒数(向上取整,用于按钮/提示文案) */
export function lockSeconds(model: AuthPanelModel, now: number = Date.now()): number {
  return Math.ceil(lockRemaining(model, now) / 1000)
}
