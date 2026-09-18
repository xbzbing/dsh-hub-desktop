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
  /** 当前是否对用户可见；用于区分「首次显示」与后续布局变化。 */
  visible: boolean
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
export function createWorkspaceHost(
  getHubWindow: () => BrowserWindow | null,
  systemLocale: () => string = () => 'en-US'
): WorkspaceHost {
  const entries = new Map<string, Entry>()
  let activeId: string | null = null
  let cacheLimit = 3
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
    // dsh 在持久化设置同步前按 navigator.languages 初始化；显式把系统语言交给这个
    // WebContentsView，避免 macOS/Electron 的默认 en-US 覆盖公共 DSH_HOME 的中文体验。
    const locale = systemLocale().toLowerCase().startsWith('zh') ? 'zh-CN,zh,en-US,en' : 'en-US,en,zh-CN,zh'
    webContents.session.setUserAgent(webContents.getUserAgent(), locale)
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
        visible: false,
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
      // WebContentsView 在加入 contentView 后会以默认大小绘制；必须先收缩并隐藏，
      // 不能让远程登录页在首帧覆盖整个应用窗口。
      entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      entry.view.setVisible(false)
      entries.set(instanceId, entry)
      win.contentView.addChildView(entry.view)
    } else {
      entry.originUrl = url
    }
    touch(entry)
    // WebContentsView 的默认可见区域会覆盖整个窗口。不能复用上一个工作区的边界，
    // 因为侧栏状态和布局可能已经变化；先收缩并隐藏，等当前渲染周期回传右侧内容区边界。
    for (const candidate of entries.values()) {
      candidate.view.setVisible(false)
      candidate.visible = false
    }
    entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    activeId = instanceId
    trimCache()
    return {
      loadURL: (target) => entry.view.webContents.loadURL(target),
      webContents: entry.view.webContents
    }
  }

  /**
   * 把键盘焦点交给工作区。
   *
   * 只聚焦子视图，绝不调用 `win.focus()`：工作区是在用户已点击本应用的窗口后打开的，
   * 此时宿主窗口已是 key window。反过来在布局/激活过程中抢窗口焦点会打断 macOS 的
   * 应用激活，表现为「窗口点不到前台、输入落到下一层」。
   */
  function focusEntry(entry: Entry): void {
    // 等本次布局提交完成后再转移键盘焦点，避免与窗口激活过程互相覆盖。
    setImmediate(() => {
      if (entry.view.webContents.isDestroyed()) return
      entry.view.webContents.focus()
    })
  }

  function hide(): void {
    if (activeId === null) return
    const entry = entries.get(activeId)
    if (entry) {
      entry.view.setVisible(false)
      entry.visible = false
    }
    activeId = null
  }

  function close(instanceId: string): void {
    const entry = entries.get(instanceId)
    if (!entry) return
    const win = getHubWindow()
    if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
    entry.visible = false
    entries.delete(instanceId)
    if (activeId === instanceId) activeId = null
  }

  function setCacheLimit(limit: number): void {
    cacheLimit = Math.max(1, Math.floor(limit))
    trimCache()
  }

  function setBounds(bounds: WorkspaceViewBounds): void {
    if (activeId === null) return
    const active = entries.get(activeId)
    if (!active) return
    active.view.setBounds(bounds)
    const visible = bounds.width > 0 && bounds.height > 0
    active.view.setVisible(visible)
    // 只在「隐藏 → 显示」时接管焦点：后续每次布局变化都抢焦点会打断用户正在进行的输入。
    const becameVisible = visible && !active.visible
    active.visible = visible
    if (becameVisible) focusEntry(active)
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
