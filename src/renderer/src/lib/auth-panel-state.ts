/**
 * 认证面板的状态归约（T8 评审修正）—— 纯函数,不 import electron/React,便于单测。
 *
 * 修正两个实测缺陷:
 * 1. **跨实例串台**:旧实现不过滤 `instanceId`,`onState` 会用实例 B 的状态覆盖
 *    为实例 A 打开的面板(而提交仍带 A 的 id → 密码会被发往 A)。本模块对
 *    `event.instanceId !== target.id` 一律忽略。
 * 2. **锁定倒计时冻结**:旧实现把 `lockedForMs` 当剩余时间渲染,而该值不会随时间变化,
 *    倒计时原地不动、到期后按钮也不恢复。本模块把 `lockedForMs` 换算成**绝对到期时刻**
 *    `lockUntil`,`lockRemaining()` 再按当前时间派生剩余毫秒 —— 倒计时因此真正走动,
 *    并在归零时提示调用方重探(`lockExpired`)。
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
 * 清除锁定态(倒计时归零 / 用户已能再次提交)。
 *
 * 评审 R4:**到期必须无条件清掉 `lockUntil`**,不能等重探结果 ——
 * 旧实现只在重探成功时才更新模型,重探返回 null/{ok:false} 时会永远停在
 * 「锁定 0s」且按钮永久 disabled(且 effect 依赖 `[model]` 不再重跑)。
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
