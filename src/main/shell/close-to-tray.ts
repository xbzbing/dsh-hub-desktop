/**
 *
 * (`shouldMinimizeToTrayOnClose(current, true)`),于是「托盘不存在时也隐藏窗口」
 * 这条会把应用变成叫不回来(只剩 macOS Dock)的路径没有任何测试约束。
 *
 * 判定(纯函数 `shouldMinimizeToTrayOnClose`)在 `native-decisions.ts` 已被穷举覆盖;
 * 这里补的是**接线**:托盘是否存在必须来自真实查询,拦截动作只在该隐藏时发生。
 */
import type { Settings } from '@shared/settings'
import { shouldMinimizeToTrayOnClose } from './native-decisions'

export interface CloseEventLike {
  preventDefault(): void
}

export interface CloseToTrayDeps {
  /** 当前偏好(`null` = 偏好尚未装配) */
  settings(): Pick<Settings, 'tray'> | null
  /** 托盘**确实存在**(注意:不是「偏好开着」) */
  trayAvailable(): boolean
  /** 正在退出时必须放行 close，不能再隐藏窗口。 */
  isQuitting(): boolean
  hideWindow(): void
}

/**
 * 处理窗口 close 事件。
 * @returns true 表示已拦截关闭并隐藏到托盘;false 表示放行(真正关闭窗口)
 */
export function handleWindowClose(event: CloseEventLike, deps: CloseToTrayDeps): boolean {
  // 托盘菜单的「退出」会触发所有窗口的 close；此时不能再把窗口藏回托盘。
  if (deps.isQuitting()) return false
  const current = deps.settings()
  // 偏好未装配时不做任何拦截(启动早期的关闭必须能真的关掉)
  if (!current) return false
  if (!shouldMinimizeToTrayOnClose(current, deps.trayAvailable())) return false
  event.preventDefault()
  deps.hideWindow()
  return true
}
