import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import type { WorkspaceTooltip } from '@shared/contracts'

export interface WorkspaceTooltipHost {
  show(tooltip: WorkspaceTooltip): Promise<void>
  hide(): void
  close(): void
}

const TOOLTIP_HEIGHT = 34
const TOOLTIP_MIN_WIDTH = 98
const TOOLTIP_MAX_WIDTH = 322

function tooltipWidth(text: string): number {
  // 中文字符与西文混排时按较保守的平均宽度预留，避免原生窗口在工作区上方截断。
  return Math.max(TOOLTIP_MIN_WIDTH, Math.min(TOOLTIP_MAX_WIDTH, Math.ceil(text.length * 14 + 24)))
}

function tooltipHtml(text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden}body{font:12px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#1f2937}main{box-sizing:border-box;height:32px;margin:1px;padding:6px 9px;border:1px solid #d8dce4;border-radius:7px;background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / .08);line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style></head><body><main>${escapeHtml(text)}</main></body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

/**
 * 原生工作区是 renderer DOM 之外的 WebContentsView，CSS z-index 无法覆盖它。
 * 这个无焦点子窗口只呈现实例名称，始终位于父窗口的工作区视图上方。
 */
export function createWorkspaceTooltipHost(
  getHubWindow: () => BrowserWindow | null,
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow = (options) => new BrowserWindow(options)
): WorkspaceTooltipHost {
  let tooltipWindow: BrowserWindow | null = null
  let displayedText: string | null = null
  let displayRequest = 0

  function validWindow(): BrowserWindow | null {
    return tooltipWindow && !tooltipWindow.isDestroyed() ? tooltipWindow : null
  }

  function ensureWindow(parent: BrowserWindow): BrowserWindow {
    const existing = validWindow()
    if (existing) return existing
    const created = createWindow({
      parent,
      width: TOOLTIP_MIN_WIDTH,
      height: TOOLTIP_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    created.setAlwaysOnTop(true, 'floating')
    created.setIgnoreMouseEvents(true, { forward: true })
    created.setMenuBarVisibility(false)
    created.setBackgroundColor('#00000000')
    tooltipWindow = created
    return created
  }

  return {
    async show(tooltip) {
      const request = ++displayRequest
      const parent = getHubWindow()
      if (!parent || parent.isDestroyed()) return
      const nativeTooltip = ensureWindow(parent)
      const parentBounds = parent.getContentBounds()
      const width = tooltipWidth(tooltip.text)
      nativeTooltip.setBounds({
        x: parentBounds.x + tooltip.x,
        y: parentBounds.y + tooltip.y - Math.floor(TOOLTIP_HEIGHT / 2),
        width,
        height: TOOLTIP_HEIGHT
      })
      if (displayedText !== tooltip.text) {
        await nativeTooltip.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(tooltipHtml(tooltip.text))}`)
        displayedText = tooltip.text
      }
      if (request === displayRequest && !nativeTooltip.isDestroyed()) nativeTooltip.showInactive()
    },

    hide() {
      displayRequest += 1
      validWindow()?.hide()
    },

    close() {
      const current = validWindow()
      if (current) current.destroy()
      tooltipWindow = null
    }
  }
}
