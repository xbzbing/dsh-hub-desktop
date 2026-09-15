/**
 * 原生设置的「动作计划」（T11）—— 纯函数,不 import electron。
 *
 * 复审反馈:托盘/自启/通知的接线全部写在 `index.ts` 的 `app.whenReady()` 内部,
 * **结构上不可测**,于是「托盘菜单不随语言刷新」「autoStart 从不落到 OS」这类缺陷
 * 可以在测试全绿的情况下存活。这里把「设置 → 该做哪些原生动作」抽成可穷举单测的计划。
 */
import type { Settings } from '@shared/settings'

export type NativeAction =
  | { kind: 'create-tray' }
  | { kind: 'destroy-tray' }
  /** 托盘已存在但文案需要刷新(如切换语言)—— 复审 R3 的缺口 */
  | { kind: 'update-tray' }
  | { kind: 'set-login-item'; autoStart: boolean }

export interface NativePlanInput {
  settings: Pick<Settings, 'tray' | 'autoStart'>
  /** 当前是否已有托盘 */
  trayExists: boolean
  /** 是否为启动时的首次应用 */
  startup: boolean
}

/**
 * 计算需要施加的原生动作。
 *
 * 约定:
 * - 托盘:关→有不留图标;不有→开则创建;**有且开则刷新文案**(语言切换后菜单不能停在旧语言);
 * - 登录项:启动时只在**需要开启**时写(避免每次启动都写一次「关闭」,在未签名环境会打权限错误);
 *   运行期的切换(含关闭)照实写入,尊重用户显式操作。
 */
export function planNativeSettings(input: NativePlanInput): NativeAction[] {
  const actions: NativeAction[] = []
  const { settings, trayExists, startup } = input

  if (settings.tray && !trayExists) actions.push({ kind: 'create-tray' })
  else if (!settings.tray && trayExists) actions.push({ kind: 'destroy-tray' })
  else if (settings.tray && trayExists) actions.push({ kind: 'update-tray' })

  if (!startup || settings.autoStart) {
    actions.push({ kind: 'set-login-item', autoStart: settings.autoStart })
  }

  return actions
}
