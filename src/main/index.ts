import { app, BrowserWindow, net, protocol, session, shell } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InstanceStatusEvent, PatchInstanceInput } from '@shared/contracts'
import { AUTH_IPC, INSTANCE_STATUS_EVENT } from '@shared/contracts'
import { registerIpc } from './ipc/register'
import { createLocalRuntime } from './local-runtime/local-runtime'
import type { LocalRuntimeManager } from './local-runtime/local-runtime'
import { createRuntimeInstaller } from './local-runtime/runtime-installer'
import { createSshTunnels } from './transport/ssh-tunnel'
import type { SshTunnelManager } from './transport/ssh-tunnel'
import { createHttpEndpoints } from './transport/http-endpoint'
import type { HttpEndpointManager } from './transport/http-endpoint'
import { createPromptBroker } from './ssh/prompt-broker'
import { createAuthRegistry } from './auth/auth-registry'
import { importSessionCookie } from './webview/cookie-import'
import { classifyAuthSignal } from './webview/intercept'
import type { PromptBroker } from './ssh/prompt-broker'
import type { AuthRegistry } from './auth/auth-registry'
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

/** 运行中的本地实例 / SSH 隧道管理器（退出前需回收进程树，故提到模块级） */
let runtime: LocalRuntimeManager | null = null
let tunnels: SshTunnelManager | null = null
/** T6 HTTP 直连管理器(无本地进程,start=校验+探测) */
let httpEndpoints: HttpEndpointManager | null = null
/** T5 提示代理:窗口关闭/退出时收敛所有待答请求(否则指纹/口令请求会挂满超时) */
let prompts: PromptBroker | null = null
/** T8 每实例认证客户端(登录成功 → 分区 Cookie 注入 → 打开视图) */
let auth: AuthRegistry | null = null
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

  // T5 用户提示代理：指纹确认 / 口令输入 → 广播到 hub 渲染窗口 → 等待回答
  prompts = createPromptBroker({
    send: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      }
    }
  })
  tunnels = createSshTunnels({
    dataRoot,
    confirmHostKey: (request) => prompts?.requestHostKey(request) ?? Promise.resolve('reject'),
    askpass: (request) => prompts?.requestAskpass(request) ?? Promise.resolve(null)
  })
  // T6 HTTP 直连:无本地进程,start = 端点校验 + §4.3 健康探测 + §2.3 认证模式探测
  httpEndpoints = createHttpEndpoints()

  // 状态推进（local + ssh 共用同一通道）→ 广播到所有窗口；把实际端口/版本回写注册表
  // （transport 感知：ssh 的「端口」是隧道本地口 localPort，local 的才是监听 port）；
  // 回收已停止实例的窗口
  const handleStatusEvent = (event: InstanceStatusEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(INSTANCE_STATUS_EVENT, event)
    }
    if (event.status === 'running' && (event.port !== undefined || event.version !== undefined)) {
      void instanceStore
        .get(event.id)
        .then((record) => {
          const patch: PatchInstanceInput = {}
          if (event.port !== undefined) {
            if (record?.transport === 'ssh') patch.localPort = event.port
            else patch.port = event.port
          }
          if (event.version !== undefined) patch.dshVersion = event.version
          return instanceStore.update(event.id, patch)
        })
        .catch((error: unknown) => console.error('[main] 回写实例运行信息失败：', error))
    }
    if (event.status === 'stopped') closeInstanceWindow(event.id)
  }
  runtime.onStatus(handleStatusEvent)
  tunnels.onStatus(handleStatusEvent)
  httpEndpoints.onStatus(handleStatusEvent)

  // T8 认证:端点取自注册表;状态变化广播给渲染层(auth-panel / 工作区浮层)
  auth = createAuthRegistry({
    resolveEndpoint: async (instanceId) => {
      const record = await instanceStore.get(instanceId)
      if (!record || record.transport === 'local') return null
      return record.transport === 'ssh' ? null : record.endpointUrl
    },
    onState: (instanceId, state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(AUTH_IPC.state, {
            instanceId,
            state,
            at: new Date().toISOString()
          })
        }
      }
    }
  })

  registerIpc(instanceStore, {
    runtime,
    tunnels,
    http: httpEndpoints,
    auth,
    prompts: prompts as PromptBroker,
    openInstanceView: (instance, url) => {
      const win = openInstanceWindow({ instanceId: instance.id, title: instance.name, url })
      // T8:把主进程会话 Cookie 写入该实例分区(§6.2),并挂 302/401 拦截(§6.3)
      const cookie = auth?.sessionCookie(instance.id) ?? null
      const parsed = (() => {
        try {
          return new URL(url)
        } catch {
          return null
        }
      })()
      if (parsed && cookie) {
        void importSessionCookie(win.webContents.session.cookies, {
          origin: `${parsed.protocol}//${parsed.host}`,
          basePath: parsed.pathname.replace(/\/+$/, '') || '/',
          cookie
        })
      }
      win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        const signal = classifyAuthSignal({
          statusCode: details.statusCode,
          headers: details.responseHeaders ?? {},
          url: details.url,
          method: details.method,
          isMainFrame: details.resourceType === 'mainFrame'
        })
        if (signal) {
          for (const target of BrowserWindow.getAllWindows()) {
            if (!target.isDestroyed()) {
              target.webContents.send(AUTH_IPC.signal, {
                instanceId: instance.id,
                signal,
                at: new Date().toISOString()
              })
            }
          }
        }
        callback({ responseHeaders: details.responseHeaders ?? {} })
      })
      return win
    }
  })

  createWindow()

  app.on('activate', () => {
    // macOS 惯例：点击 Dock 图标且无窗口时重建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // T5:窗口关闭即收敛未答的指纹/口令请求(否则最长挂 5-10 分钟,期间隧道启动被卡住)
  app.on('browser-window-created', (_event, win) => {
    win.on('closed', () => {
      if (BrowserWindow.getAllWindows().filter((other) => !other.isDestroyed()).length === 0) {
        prompts?.cancelAll()
      }
    })
  })
})

app.on('before-quit', (event) => {
  // 退出前回收全部实例进程树与 SSH 隧道（设计 §4.1/§4.2：不留孤儿进程）
  if (quitting || (!runtime && !tunnels && !httpEndpoints)) return
  quitting = true
  event.preventDefault()
  const recycling: Array<Promise<void>> = []
  if (runtime) {
    recycling.push(runtime.stopAll().catch((error: unknown) => console.error('[main] 停止实例失败：', error)))
  }
  if (tunnels) {
    recycling.push(
      tunnels.stopAll().catch((error: unknown) => console.error('[main] 停止隧道失败：', error))
    )
  }
  if (httpEndpoints) {
    recycling.push(
      httpEndpoints
        .stopAll()
        .catch((error: unknown) => console.error('[main] 停止 HTTP 实例失败：', error))
    )
  }
  void Promise.all(recycling).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  // 全部窗口关闭:先收敛待答请求(macOS 进程可能驻留,请求不能悬着)
  prompts?.cancelAll()
  // macOS 之外：全部窗口关闭即退出；macOS 保留进程（托盘能力在 T10 引入）
  if (process.platform !== 'darwin') app.quit()
})