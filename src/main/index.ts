import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC, type AppInfo, type PingResult } from '@shared/bridge'

const isDev = !app.isPackaged
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'] ?? null

/**
 * 生产环境渲染器走自定义 `app://hub` 协议而不是 file://：
 * 1. file:// 下 CSP 的 `'self'` 语义不可用，script 会被误杀；
 * 2. app:// 提供稳定的 origin，未来 HttpOnly cookie 注入与存储作用域都有明确宿主。
 * 布局上对应设计稿 `design/dsh-hub-desktop.html` 中的 `.window`（真实窗口替换模拟窗口，见走查报告）。
 */
const RENDERER_ORIGIN = 'app://hub'

/**
 * 生产环境 CSP（设计文档 §7 安全基线）。
 * dev 由 Vite/HMR 自行管理资源，不注入，避免打断热更新。
 */
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

// 必须在 app ready 之前注册自定义协议的权限
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

/**
 * 数据目录可被 `DSH_HUB_DATA_DIR` 覆盖（须在 ready 前生效）。
 * 用途：让 E2E / 契约测试把应用数据写入隔离目录，避免污染真实用户数据，
 * 也便于在受限环境下把 userData 指到可写位置（如 CI 沙箱）。
 */
const userDataOverride = process.env['DSH_HUB_DATA_DIR']?.trim()
if (userDataOverride) app.setPath('userData', userDataOverride)

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'DSH Hub',
    // brand-spec 深色 --bg（oklch(0.185 0.012 265) 的 sRGB 近似），避免加载期白闪
    backgroundColor: '#101318',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // 外部链接一律交给系统浏览器；窗口内不允许导航到任何非应用地址
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })

  if (isDev && rendererDevUrl) void win.loadURL(rendererDevUrl)
  else void win.loadURL(`${RENDERER_ORIGIN}/index.html`)

  return win
}

function isAllowedNavigation(url: string): boolean {
  try {
    const target = new URL(url)
    if (isDev && rendererDevUrl) return target.origin === new URL(rendererDevUrl).origin
    return target.origin === RENDERER_ORIGIN
  } catch {
    return false
  }
}

function registerRendererProtocol(): void {
  const root = join(__dirname, '../renderer')
  protocol.handle('app', (request) => {
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const filePath = normalize(join(root, rel))
    // 目录穿越防护：解析结果必须仍位于 renderer 产物根之下
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function registerCsp(): void {
  if (isDev) return
  // 注意：同一条 onHeadersReceived 通道会在 T4 用于 HttpOnly cookie 注入，届时在此扩展
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_POLICY]
      }
    })
  })
}

function registerIpc(): void {
  const processVersions = process.versions as NodeJS.ProcessVersions & { electron?: string }

  ipcMain.handle(IPC.info, (): AppInfo => ({
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    chrome: process.versions.chrome,
    electron: processVersions.electron ?? '',
    node: process.versions.node,
    userDataPath: app.getPath('userData')
  }))

  ipcMain.handle(IPC.ping, (_event, message: unknown): PingResult => {
    const echo = typeof message === 'string' && message !== '' ? message : null
    return { ok: true, echo, at: Date.now() }
  })
}

void app.whenReady().then(() => {
  registerRendererProtocol()
  registerCsp()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    // macOS 惯例：点击 Dock 图标且无窗口时重建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS 之外：全部窗口关闭即退出；macOS 保留进程（托盘能力在 T10 引入）
  if (process.platform !== 'darwin') app.quit()
})