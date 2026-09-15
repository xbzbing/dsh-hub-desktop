import { app, BrowserWindow, net, protocol, session, shell } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { INSTANCE_STATUS_EVENT } from '@shared/contracts'
import { registerIpc } from './ipc/register'
import { createLocalRuntime, type LocalRuntimeManager } from './local-runtime/local-runtime'
import { createRuntimeInstaller } from './local-runtime/runtime-installer'
import { createInstanceStore } from './registry/instance-store'
import { closeInstanceWindow, openInstanceWindow } from './window-host'

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
 * 判定 URL 是否属于本应用渲染器 origin。
 * 不能用 `url.origin === RENDERER_ORIGIN`：Node 的 WHATWG URL 不认识 `app:` 注册为
 * standard scheme（那是 Electron 侧注册的），对非 standard scheme `origin` 恒为 `'null'`。
 */
function isRendererOrigin(url: URL): boolean {
  return url.protocol === 'app:' && url.hostname === 'hub'
}

/**
 * 生产形态 CSP（设计文档 §7 安全基线）。
 * 仅当不使用 Vite dev server 时注入（dev 由 HMR 自行管理资源，注入会打断热更新）。
 * 不依赖 isPackaged：E2E 以未打包形态启动但无 dev server，同样会走到注入路径，让 CSP 可被冒烟覆盖。
 */
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
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
    return isRendererOrigin(target)
  } catch {
    return false
  }
}

function registerRendererProtocol(): void {
  const root = join(__dirname, '../renderer')
  protocol.handle('app', (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    // 只服务 `app://hub` 这个固定 origin，host 不一致一律拒绝
    if (!isRendererOrigin(url)) {
      return new Response('Forbidden', { status: 403 })
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
    const filePath = normalize(join(root, rel))
    // 目录穿越防护：解析结果必须仍位于 renderer 产物根之下
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function registerCsp(): void {
  // 语义见 CSP_POLICY 注释：不用 isDev，用「是否挂 dev server」决定
  if (rendererDevUrl) return
  // 注意：同一条 onHeadersReceived 通道会在 T4 用于 HttpOnly cookie 注入，届时在此扩展。
  // CSP 只作用于本应用 origin，绝不扩散到未来 webview 加载的远端实例内容。
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    let url: URL | null = null
    try {
      url = new URL(details.url)
    } catch {
      url = null
    }
    if (!url || !isRendererOrigin(url)) {
      callback({ responseHeaders: details.responseHeaders ?? {} })
      return
    }
    // 注意：必须保留原响应头（含 Content-Type —— module script 依赖 JS MIME 才允许执行），
    // 只追加 CSP；responseHeaders 为空时也要兜底，否则会丢掉所有原有头。
    callback({
      responseHeaders: {
        ...(details.responseHeaders ?? {}),
        'Content-Security-Policy': [CSP_POLICY]
      }
    })
  })
}

/** 运行中的本地实例管理器（退出前需回收进程树，故提到模块级） */
let runtime: LocalRuntimeManager | null = null
let quitting = false

void app.whenReady().then(() => {
  registerRendererProtocol()
  registerCsp()

  const dataRoot = app.getPath('userData')
  // 注册表落盘位置：<userData>/registry/instances.json（+ 滚动备份 + 损坏隔离）
  const instanceStore = createInstanceStore({ dir: join(dataRoot, 'registry') })
  // npm registry 可经环境变量覆盖：默认跟随系统 npm 配置；
  // 内网/海外网络慢时可指到镜像，如 DSH_HUB_NPM_REGISTRY=https://registry.npmmirror.com
  const npmRegistry = process.env['DSH_HUB_NPM_REGISTRY']?.trim() || undefined
  const installer = createRuntimeInstaller({
    runtimesDir: join(dataRoot, 'runtimes'),
    cacheDir: join(dataRoot, 'npm-cache'),
    ...(npmRegistry ? { registry: npmRegistry } : {})
  })
  runtime = createLocalRuntime({ installer, dataRoot })

  // 状态推进 → 广播到所有窗口；并把实际端口/版本回写注册表、回收已停止实例的窗口
  runtime.onStatus((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(INSTANCE_STATUS_EVENT, event)
    }
    if (event.status === 'running' && (event.port !== undefined || event.version !== undefined)) {
      void instanceStore
        .update(event.id, {
          ...(event.port !== undefined ? { port: event.port } : {}),
          ...(event.version !== undefined ? { dshVersion: event.version } : {})
        })
        .catch((error: unknown) => console.error('[main] 回写实例运行信息失败：', error))
    }
    if (event.status === 'stopped') closeInstanceWindow(event.id)
  })

  registerIpc(instanceStore, {
    runtime,
    openInstanceView: (instance, url) =>
      openInstanceWindow({ instanceId: instance.id, title: instance.name, url })
  })

  createWindow()

  app.on('activate', () => {
    // macOS 惯例：点击 Dock 图标且无窗口时重建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  // 退出前回收全部实例进程树（设计 §4.1：不留孤儿进程）
  if (quitting || !runtime) return
  quitting = true
  event.preventDefault()
  void runtime
    .stopAll()
    .catch((error: unknown) => console.error('[main] 停止实例失败：', error))
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  // macOS 之外：全部窗口关闭即退出；macOS 保留进程（托盘能力在 T10 引入）
  if (process.platform !== 'darwin') app.quit()
})