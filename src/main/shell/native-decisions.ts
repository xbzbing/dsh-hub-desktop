/**
 *
 * 设置页的开关必须驱动**真实行为**,但「什么时候该弹通知 / 该不该设开机自启」
 * 这类判断是纯逻辑,抽出来穷举单测,electron 侧只做接线。
 */
import type { InstanceRuntimeStatus, InstanceStatusEvent } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import type { Settings } from '@shared/settings'

/** 值得打扰用户的状态(其余变化只更新 UI) */
const NOTIFIABLE: readonly InstanceRuntimeStatus[] = ['running', 'error']

/**
 * 是否应为这次状态变化弹系统通知。
 *
 * 刻意排除的情况:
 * - 用户关掉了通知偏好;
 * - **首次观测**(`previous === null`):应用启动时会把每个实例的当前状态重放一遍,
 *   若据此通知,开机就会弹一堆「运行中」;
 * - 状态未变化(同一状态重复上报):避免同一结果被通知多次;
 * - `stopped`/`starting`:停止是用户主动操作,启动中无需告知。
 */
export function shouldNotifyStatus(
  event: Pick<InstanceStatusEvent, 'status'>,
  previous: InstanceRuntimeStatus | null,
  settings: Pick<Settings, 'notifications'>
): boolean {
  if (!settings.notifications) return false
  if (previous === null) return false
  if (previous === event.status) return false
  return NOTIFIABLE.includes(event.status)
}

/**
 * 关闭窗口时是否应最小化到托盘(而不是退出应用)。
 *
 * **必须同时满足「偏好开启」与「托盘确实存在」**:偏好开着却没有托盘时隐藏窗口,
 * 应用就再也叫不回来了(只剩 macOS Dock)。这是把「隐藏」当成不可逆操作来对待。
 */
export function shouldMinimizeToTrayOnClose(
  settings: Pick<Settings, 'tray'>,
  trayAvailable: boolean
): boolean {
  return settings.tray && trayAvailable
}

/**
 * 开机自启的登录项设置。
 *
 * `openAsHidden` 仅在 macOS 有意义:自启时不让实例窗口抢焦点
 * (设计意图是「后台把实例拉起来」,不是「开机就弹窗」)。
 */
export function loginItemSettings(settings: Pick<Settings, 'autoStart'>): {
  openAtLogin: boolean
  openAsHidden: boolean
} {
  return { openAtLogin: settings.autoStart, openAsHidden: settings.autoStart }
}

/**
 *
 * 通知接线（含硬编码中文）在 `index.ts` 里既无测试也无法测。
 * @returns null 表示不通知
 */
export function notificationPlan(
  event: Pick<InstanceStatusEvent, 'status' | 'detail'> & { id: string },
  previous: InstanceRuntimeStatus | null,
  settings: Pick<Settings, 'notifications'>,
  t: Translator
): { title: string; body: string } | null {
  if (!shouldNotifyStatus(event, previous, settings)) return null
  const label = event.status === 'running' ? t('notify.connected') : t('notify.error')
  return {
    title: `${t('app.name')} · ${label}`,
    body: event.detail ?? event.id
  }
}
