import { WebContentsView, type BrowserWindow } from 'electron'
import type { WorkspaceViewBounds } from '@shared/contracts'
import { isAllowedInstanceNavigation } from './window-host-policy'

export interface WorkspaceView {
  loadURL(url: string): Promise<void>
  webContents: {
    session: Electron.Session
    getURL(): string
    on(event: 'will-redirect', listener: (_event: { preventDefault(): void }, url: string) => void): void
  }
}

interface Entry {
  instanceId: string
  originUrl: string
  view: WebContentsView
  lastUsed: number
}

export interface WorkspaceHost {
  prepare(instanceId: string, url: string): WorkspaceView
  /** 调整已缓存实例视图上限；超出的最久未使用非活动视图立即回收。 */
  setCacheLimit(limit: number): void
  setBounds(bounds: WorkspaceViewBounds): void
  hide(): void
  close(instanceId: string): void
  closeAll(): void
}

/**
 * Hosts an authenticated workspace in a main-process WebContentsView.
 * The renderer receives only visibility state and cannot access guest DOM, URLs, or cookies.
 */
export function createWorkspaceHost(getHubWindow: () => BrowserWindow | null): WorkspaceHost {
  const entries = new Map<string, Entry>()
  let activeId: string | null = null
  let activeBounds: WorkspaceViewBounds | null = null
  let cacheLimit = 5
  let useSequence = 0

  function touch(entry: Entry): void {
    useSequence += 1
    entry.lastUsed = useSequence
  }

  function trimCache(): void {
    while (entries.size > cacheLimit) {
      const oldest = [...entries.values()]
        .filter((entry) => entry.instanceId !== activeId)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (!oldest) return
      close(oldest.instanceId)
    }
  }

  function configure(entry: Entry): void {
    const { webContents } = entry.view
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    webContents.on('will-navigate', (event, url) => {
      if (!isAllowedInstanceNavigation(url, entry.originUrl)) event.preventDefault()
    })
    webContents.on('will-redirect', (event, url) => {
      if (!isAllowedInstanceNavigation(url, entry.originUrl)) event.preventDefault()
    })
    webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    webContents.session.setPermissionCheckHandler(() => false)
    webContents.session.on('will-download', (event) => event.preventDefault())
  }

  function prepare(instanceId: string, url: string): WorkspaceView {
    const win = getHubWindow()
    if (!win || win.isDestroyed()) throw new Error('工作区主窗口不可用')
    let entry = entries.get(instanceId)
    if (!entry) {
      entry = {
        instanceId,
        originUrl: url,
        lastUsed: 0,
        view: new WebContentsView({
          webPreferences: {
            partition: `persist:inst-${instanceId}`,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webviewTag: false,
            spellcheck: false
          }
        })
      }
      configure(entry)
      entries.set(instanceId, entry)
      win.contentView.addChildView(entry.view)
    } else {
      entry.originUrl = url
    }
    touch(entry)
    for (const candidate of entries.values()) candidate.view.setVisible(candidate.instanceId === instanceId)
    if (activeBounds) entry.view.setBounds(activeBounds)
    activeId = instanceId
    trimCache()
    return {
      loadURL: (target) => entry.view.webContents.loadURL(target),
      webContents: entry.view.webContents
    }
  }

  function hide(): void {
    if (activeId === null) return
    entries.get(activeId)?.view.setVisible(false)
    activeId = null
  }

  function close(instanceId: string): void {
    const entry = entries.get(instanceId)
    if (!entry) return
    const win = getHubWindow()
    if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
    entries.delete(instanceId)
    if (activeId === instanceId) activeId = null
  }

  function setCacheLimit(limit: number): void {
    cacheLimit = Math.max(1, Math.floor(limit))
    trimCache()
  }

  function setBounds(bounds: WorkspaceViewBounds): void {
    activeBounds = bounds
    if (activeId === null) return
    entries.get(activeId)?.view.setBounds(bounds)
  }

  function closeAll(): void {
    for (const instanceId of [...entries.keys()]) close(instanceId)
  }

  return {
    prepare,
    setCacheLimit,
    setBounds,
    hide,
    close,
    closeAll
  }
}
