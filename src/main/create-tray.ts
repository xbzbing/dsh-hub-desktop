import { app } from 'electron'
import type { Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { InstanceRuntimeStatus } from '@shared/contracts'
import { createTranslator } from '@shared/i18n'
import { resolveLanguage } from '@shared/settings'
import type { Settings } from '@shared/settings'
import { createHubNativePorts } from './shell/native-ports'
import type { HubNativePorts } from './shell/native-ports'
import { systemLocale } from './system-locale'
import { createHubTray, updateTrayStatus } from './tray'
import type { HubTrayLabels } from './tray'

export interface TrayControllerDeps {
  /** 当前偏好（托盘文案取语言） */
  readSettings: () => Settings
  /** 主进程维护的运行时状态表（状态行统计 running 实例数） */
  runtimeStates: ReadonlyMap<string, InstanceRuntimeStatus>
  /** 召出主窗口 */
  onShow: () => void
  /** 退出应用 */
  onQuit: () => void
}

export interface TrayController {
  /** 原生端口（托盘 + 登录项）；由调用方装配到应用状态 */
  ports: HubNativePorts<Tray>
  /** 实例状态变化后刷新托盘菜单的状态行 */
  refreshStatus: () => void
}

/**
 * 托盘图标、状态行文案与原生端口（托盘 + 登录项）的装配。
 */
export function createTrayController(deps: TrayControllerDeps): TrayController {
  /**
   * 托盘图标路径。
   *
   * macOS 用模板图 `trayTemplate.png`(文件名以 Template 结尾,菜单栏按明暗自动反色),
   * Windows / Linux 用彩色图 `tray.png`。打包后资源由 electron-builder 放在
   * `process.resourcesPath`,开发期回落仓库内的 `resources/`;两者都没有时返回
   * 仓库相对路径,由 `nativeImage.createFromPath` 渲染为空图。
   */
  function trayIconPath(): string {
    const name = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
    const candidates = [join(process.resourcesPath, name), join(__dirname, '../../resources', name)]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return candidates[candidates.length - 1] as string
  }

  /** 当前处于 running 的实例数(托盘状态行) */
  function runningInstanceCount(): number {
    let count = 0
    for (const status of deps.runtimeStates.values()) if (status === 'running') count += 1
    return count
  }

  /** 托盘文案跟随当前语言(与设置页一致) */
  function trayLabels(): HubTrayLabels {
    const language = resolveLanguage(deps.readSettings().language, systemLocale())
    const tr = createTranslator(language)
    return {
      tooltip: tr('app.name'),
      show: tr('tray.show'),
      quit: tr('tray.quit'),
      // 状态行取自主进程已在维护的运行时状态表(无需再读注册表)
      status: tr('tray.status', { count: runningInstanceCount() })
    }
  }

  // 图标/文案都是**动态取值**:语言或运行中实例数变了,刷新时必须重新求值
  const ports = createHubNativePorts<Tray>({
    iconPath: trayIconPath,
    labels: trayLabels,
    createTray: (options) => createHubTray(options),
    refreshTrayMenu: (tray, labels, onShow, onQuit) =>
      updateTrayStatus(tray, labels, onShow, onQuit),
    applyLoginItem: (value) => app.setLoginItemSettings(value),
    onShow: deps.onShow,
    onQuit: deps.onQuit,
    onError: (error, action) => console.error('[main] 应用原生设置失败：', action, error)
  })

  const refreshStatus = (): void => {
    // 托盘菜单的状态行跟随实例变化刷新(只有托盘**确实存在**时才刷新)
    const tray = ports.currentTray()
    if (!tray) return
    try {
      ports.updateTray()
    } catch (error) {
      console.error('[main] 刷新托盘菜单失败：', error)
    }
  }

  return { ports, refreshStatus }
}
