import type { BrowserWindow } from 'electron'
import { WORKSPACE_HOTKEY_EVENT } from '@shared/contracts'

/**
 * Hub 窗口失焦、隐藏或重新聚焦时，通知渲染层重置按住态。
 *
 * 工作区视图（WebContentsView）持有键盘焦点时，Hub 渲染层收不到 window blur；
 * 用户 Alt+Tab 切走后，切换修饰键的 keyup 也不会回到本窗口，侧栏的 #1-#9 角标
 * 会一直停留。窗口级焦点变化由主进程补发，渲染层收到后清空按住态。
 */
export function installHotkeyFocusReset(win: BrowserWindow): void {
  const reset = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send(WORKSPACE_HOTKEY_EVENT, { phase: 'reset' })
  }
  win.on('blur', reset)
  win.on('focus', reset)
  win.on('hide', reset)
}
