/**
 * 托盘（T11 —— 设计稿 tray-menu）—— 唯一 import electron 的托盘装配点。
 *
 * 存在的**正确性理由**(不只是功能):偏好「关闭窗口时最小化到托盘」会让
 * `win.close()` 被 `preventDefault` + `hide()` 拦下。若此时**没有托盘**,
 * 应用就再也叫不回来了(只剩 macOS Dock)。因此:
 * 1. 只有托盘**确实存在**时才允许隐藏到托盘(`shouldHideOnClose` 由 index 传入托盘状态);
 * 2. 偏好从开变关时销毁托盘;从关变开时创建托盘;
 * 3. 托盘菜单至少提供「显示主窗口」与「退出」,保证任何状态下都有出路。
 */
import { Menu, Tray, nativeImage } from 'electron'
import type { NativeImage } from 'electron'

export interface HubTrayLabels {
  tooltip: string
  show: string
  quit: string
  /** 状态行(禁用项),如「3 个实例 · 2 个运行中」 */
  status: string
}

export interface CreateHubTrayOptions {
  /** 模板图路径(macOS 菜单栏按明暗自动反色) */
  iconPath: string
  labels: HubTrayLabels
  onShow: () => void
  onQuit: () => void
}

/** 生成托盘图标(macOS 用模板图;其它平台回落到同一张图) */
export function trayIconFrom(iconPath: string): NativeImage {
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return image
  return image
}

export function createHubTray(options: CreateHubTrayOptions): Tray {
  const tray = new Tray(trayIconFrom(options.iconPath))
  tray.setToolTip(options.labels.tooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: options.labels.status, enabled: false },
      { type: 'separator' },
      { label: options.labels.show, click: options.onShow },
      { type: 'separator' },
      { label: options.labels.quit, click: options.onQuit }
    ])
  )
  // 左键点击直接显示主窗口(macOS 上默认只弹菜单,这里给一个更直接的入口)
  tray.on('click', options.onShow)
  return tray
}

/** 更新托盘菜单的状态行(实例数变化时调用) */
export function updateTrayStatus(tray: Tray, labels: HubTrayLabels, onShow: () => void, onQuit: () => void): void {
  tray.setToolTip(labels.tooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.status, enabled: false },
      { type: 'separator' },
      { label: labels.show, click: onShow },
      { type: 'separator' },
      { label: labels.quit, click: onQuit }
    ])
  )
}
