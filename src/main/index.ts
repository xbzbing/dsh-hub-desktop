import {
  app,
  BrowserWindow,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell
} from 'electron'
import { existsSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AuthPhase,
  InstanceRuntimeStatus,
  InstanceStatusEvent,
  PatchInstanceInput
} from '@shared/contracts'
import { AUTH_IPC, INSTANCE_STATUS_EVENT } from '@shared/contracts'
import { registerIpc } from './ipc/register'
import { createLocalRuntime } from './local-runtime/local-runtime'
import type { LocalRuntimeManager } from './local-runtime/local-runtime'
import { createRuntimeInstaller } from './local-runtime/runtime-installer'
import { createSshTunnels } from './transport/ssh-tunnel'
import { authEndpointOf } from './transport/endpoint-resolver'
import type { SshTunnelManager } from './transport/ssh-tunnel'
import { createHttpEndpoints } from './transport/http-endpoint'
import type { HttpEndpointManager } from './transport/http-endpoint'
import { createPromptBroker } from './ssh/prompt-broker'
import { createAuthRegistry } from './auth/auth-registry'
import { restoreSessionFromVault } from './auth/session-restore'
import { buildOpenViewPlan, classifyViewResponse } from './webview/open-view-plan'
import { planPartitionClear } from './webview/partition-clear-plan'
import {
  createOncePerSession,
  openInstanceView as openInstanceViewFlow
} from './webview/instance-view'
import { clearSessionCookie } from './webview/session-cookie'
import type { PromptBroker } from './ssh/prompt-broker'
import type { AuthRegistry } from './auth/auth-registry'
import { createInstanceStore } from './registry/instance-store'
import { createVault } from './vault/vault'
import { createAuditLog } from './audit/audit-log'
import { createSettingsStore } from './settings/settings-store'
import { createHubTray, updateTrayStatus } from './tray'
import type { HubTrayLabels } from './tray'
import { createTranslator } from '@shared/i18n'
import { resolveLanguage } from '@shared/settings'
import type { Tray } from 'electron'
import type { SettingsStore } from './settings/settings-store'
import {
  loginItemSettings,
  notificationPlan,
  shouldMinimizeToTrayOnClose
} from './shell/native-decisions'
import { planNativeSettings } from './shell/native-settings'
import { mapAuthTransition, mapRuntimeTransition } from './audit/audit-mapping'
import type { Vault } from './vault/vault'
import type { Settings } from '@shared/settings'
import type { AuditLog } from './audit/audit-log'
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

/**
 * hub 窗口引用（T8 修正）：`auth:signal` 只发给 hub 窗口 ——
 * 实例窗口没有 preload，收到也无消费者；`auth:state` 仍广播（详情页可能在任一窗口）。
 */
let hubWindow: BrowserWindow | null = null

/** T10 数据面:凭据保险库与审计日志(在 whenReady 内装配) */
let vault: Vault | null = null
let audit: AuditLog | null = null

/**
 * T11 偏好。挂到模块级是因为 **窗口的 close 处理器需要读当前偏好**
 * (「关闭时最小化到托盘」),而窗口创建早于/独立于装配顺序。
 */
let settingsRef: SettingsStore | null = null

/** T11 托盘(仅在偏好开启时存在;close-to-tray 依赖它存在才允许隐藏) */
let hubTray: Tray | null = null

/**
 * 托盘图标路径。
 *
 * 打包后资源不在 `out/main` 的相对位置,而是由 electron-builder 经
 * `extraResources` 放到 `process.resourcesPath`(T13 配置)。两处都探测,
 * 避免「开发能跑、打包后托盘空白」这类只在发行版出现的问题。
 */
function trayIconPath(): string {
  const candidates = [
    join(process.resourcesPath, 'trayTemplate.png'),
    join(__dirname, '../../resources/trayTemplate.png')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[candidates.length - 1] as string
}

/** 从托盘召出主窗口(没有窗口就重建) */
function showHubWindow(): void {
  if (hubWindow && !hubWindow.isDestroyed()) {
    hubWindow.show()
    hubWindow.focus()
  } else {
    createWindow()
  }
}

/** 从托盘退出(绕过「关闭即隐藏」) */
function quitApp(): void {
  quitting = true
  app.quit()
}

/**
 * 上一个「已广播」的状态,用于把迁移翻译成审计事件(§7.5)。
 * 放在主进程而不是渲染层:即使没有窗口(后台启动)审计也要完整。
 */
/** auth 注册表引用(供会话持久化读取 Cookie;装配时赋值) */
let authRegistryRef: AuthRegistry | null = null

const lastAuthState = new Map<string, { phase: AuthPhase; lockedForMs: number; lastErrorCode: string | null }>()
const lastRuntimeState = new Map<string, InstanceRuntimeStatus>()

/** 审计是旁路:失败绝不冒泡进业务流(§7.1「I 泄露」的可用性对偶面) */
function auditWrite(entry: Parameters<AuditLog['write']>[0]): void {
  void audit?.write(entry).catch(() => undefined)
}

/**
 * 会话建立后按勾选策略把 Cookie 写进钥匙串(§7.2)。
 * 幂等:同一个值已在 vault 里就不再写(避免每次状态推进都写文件)。
 * 失败只记日志:记住登录态是附加能力,不能影响已经成功的登录。
 */
async function persistSessionIfOptedIn(
  instanceId: string,
  registry: AuthRegistry | null = authRegistryRef
): Promise<void> {
  try {
    if (!vault || !registry) return
    if (!vault.getPolicy(instanceId).rememberSession) return
    const cookie = registry.sessionCookie(instanceId)
    if (!cookie || cookie.value === '') return
    const existing = vault.getSession(instanceId)
    if (existing?.value === cookie.value) return
    await vault.rememberSession(instanceId, cookie)
    auditWrite({ instanceId, event: 'vault-write', result: 'session' })
  } catch (error) {
    console.error('[main] 记住登录态失败(会话已建立)：', error)
  }
}

/**
 * 302/401 拦截「每分区会话只装一次」守卫 —— 详见 `webview/instance-view.ts`
 * (`onHeadersReceived` 为追加语义,重复 openView 会叠加监听器)。
 */
const shouldInstallIntercept = createOncePerSession<Electron.Session>()

/**
 * 会话失效「静默重探」在飞守卫:一个会话失效的页面会因多个子资源产生多条信号,
 * 无守卫时会对同一实例并发重探多次(徒增网关压力)。渲染层侧另有同义守卫。
 */
const reprobeInFlight = new Set<string>()

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

  // T11:偏好「关闭窗口时最小化到托盘」——此时关闭不销毁窗口,而是隐藏
  win.on('close', (event) => {
    const current = settingsRef?.read()
    // 托盘不存在时绝不隐藏:否则窗口关掉后应用无法召回(只剩 macOS Dock)
    if (!current || !shouldMinimizeToTrayOnClose(current, hubTray !== null)) return
    event.preventDefault()
    win.hide()
  })

  win.on('closed', () => {
    if (hubWindow === win) hubWindow = null
  })
  hubWindow = win
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
  // T10 §7.2:safeStorage 不可用时降级为纯内存(绝不退化成明文落盘),由 UI 告警
  const safeStorageAvailable = (() => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  })()
  vault = createVault({
    filePath: join(dataRoot, 'vault', 'credentials.json'),
    crypto: {
      isAvailable: () => safeStorageAvailable,
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, 'base64'))
    }
  })
  // T11 偏好(非敏感):语言/主题/托盘/自启/通知
  const settings = createSettingsStore({ dir: dataRoot })
  settingsRef = settings

  /**
   * 把偏好施加到原生层(开机自启)。失败只记日志:
   * 偏好已落盘,系统层面设置失败不该让设置页报错。
   */
  /**
   * 施加原生设置。
   *
   * 「该做哪些动作」由纯函数 `planNativeSettings` 决定(可穷举单测,复审指出此前的
   * 接线在 `app.whenReady()` 内结构上不可测),这里只负责把动作落到 electron API。
   */
  const applyNativeSettings = (current: Settings, options: { startup?: boolean } = {}): void => {
    const actions = planNativeSettings({
      settings: current,
      trayExists: hubTray !== null,
      startup: options.startup === true
    })
    for (const action of actions) {
      try {
        switch (action.kind) {
          case 'create-tray':
            hubTray = createHubTray({
              iconPath: trayIconPath(),
              labels: trayLabels(),
              onShow: showHubWindow,
              onQuit: quitApp
            })
            break
          case 'destroy-tray':
            hubTray?.destroy()
            hubTray = null
            break
          case 'update-tray':
            // 复审 R3:语言切换后必须刷新菜单文案
            if (hubTray) updateTrayStatus(hubTray, trayLabels(), showHubWindow, quitApp)
            break
          case 'set-login-item':
            app.setLoginItemSettings(loginItemSettings({ autoStart: action.autoStart }))
            break
        }
      } catch (error) {
        console.error('[main] 应用原生设置失败：', action.kind, error)
      }
    }
  }

  /** 当前处于 running 的实例数(托盘状态行) */
  function runningInstanceCount(): number {
    let count = 0
    for (const status of lastRuntimeState.values()) if (status === 'running') count += 1
    return count
  }

  /** 托盘文案跟随当前语言(与设置页一致) */
  function trayLabels(): HubTrayLabels {
    const language = resolveLanguage(settings.read().language, app.getLocale())
    const tr = createTranslator(language)
    return {
      tooltip: tr('app.name'),
      show: tr('tray.show'),
      quit: tr('tray.quit'),
      // 状态行取自主进程已在维护的运行时状态表(无需再读注册表)
      status: tr('tray.status', { count: runningInstanceCount() })
    }
  }
  applyNativeSettings(settings.read(), { startup: true })
  // T10 §7.5:审计 JSONL(按日历日轮转,保留 90 天,不含任何凭据)
  audit = createAuditLog({ dir: join(dataRoot, 'audit') })
  if (!safeStorageAvailable) {
    // 降级必须留痕,且只记枚举不记内容
    auditWrite({ event: 'vault-unavailable', result: 'degraded' })
  }
  // 启动时清理过期归档(不阻塞启动)
  void audit.prune().catch((error: unknown) => console.error('[main] 审计归档清理失败：', error))
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
    // T10 §7.5:运行时迁移 → connect/disconnect/ssh-exit/ssh-reconnect
    const previousStatus = lastRuntimeState.get(event.id) ?? null
    for (const entry of mapRuntimeTransition(
      event.id,
      previousStatus === null ? null : { status: previousStatus },
      { status: event.status }
    )) {
      auditWrite(entry)
    }
    // T11:按偏好弹系统通知(首次观测/状态未变化/停止与启动中都不打扰)
    const notifyPrevious = previousStatus
    {
      try {
        const tr = createTranslator(resolveLanguage(settings.read().language, app.getLocale()))
        const plan = notificationPlan(event, notifyPrevious, settings.read(), tr)
        if (plan && Notification.isSupported()) {
          new Notification({ title: plan.title, body: plan.body }).show()
        }
      } catch (error) {
        console.error('[main] 发送系统通知失败：', error)
      }
    }
    lastRuntimeState.set(event.id, event.status)
    // 托盘菜单的状态行跟随实例变化刷新(托盘存在时)
    if (hubTray) {
      try {
        updateTrayStatus(hubTray, trayLabels(), showHubWindow, quitApp)
      } catch (error) {
        console.error('[main] 刷新托盘菜单失败：', error)
      }
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
    // T9/T10:重启后按「记住登录态」策略静默复用会话(§7.2)
    restore: async (instanceId, client) => {
      if (!vault) return
      await restoreSessionFromVault({ vault }, instanceId, client)
    },
    resolveEndpoint: async (instanceId) => {
      const record = await instanceStore.get(instanceId)
      if (!record) return null
      // 认证探测端点与「开窗/探测」同源(§2.4):ssh 走隧道本地口,隧道未就绪则为 null
      // 只取**实时**隧道端口:注册表的 localPort 可能已陈旧(隧道重启会重新分配),
      // 用它会让 auth-registry 提前创建并永久缓存一个指向死端口的客户端(复审回归 b)。
      // 「隧道已停也要能清 Cookie」的需求由 clearPartitionSession 的 plan 承担。
      const tunnelPort =
        record.transport === 'ssh' ? tunnels?.statusOf(instanceId)?.port : undefined
      return authEndpointOf(record, tunnelPort)
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
      // T10 §7.5:认证迁移 → login-success/login-failed/rate-limited/lockout/session-revoked
      const previous = lastAuthState.get(instanceId) ?? null
      for (const entry of mapAuthTransition(instanceId, previous, state)) {
        auditWrite(entry)
      }
      lastAuthState.set(instanceId, {
        phase: state.phase,
        lockedForMs: state.lockedForMs,
        lastErrorCode: state.lastErrorCode
      })
      // T10 §7.2:勾选了「记住登录态」才把会话 Cookie 写进钥匙串(重启静默复用的前提)
      if (state.phase === 'connected') void persistSessionIfOptedIn(instanceId)
    }
  })

  authRegistryRef = auth

  registerIpc(instanceStore, {
    runtime,
    tunnels,
    http: httpEndpoints,
    auth,
    vault: vault as Vault,
    settings,
    audit: auditWrite,
    onSettingsChanged: applyNativeSettings,
    // T9:登出时清该实例分区内的会话 Cookie(origin 取自实例记录)
    clearPartitionSession: async (instanceId) => {
      const record = await instanceStore.get(instanceId)
      // 计划由可测纯函数推导(T9-2):隧道已停时回落注册表持久化的 localPort,
      // 否则「先停隧道再清 Cookie」会静默 no-op
      const plan = planPartitionClear(record, tunnels?.statusOf(instanceId)?.port)
      if (!plan) return
      const target = session.fromPartition(plan.partition)
      await clearSessionCookie(target.cookies, { origin: plan.origin, basePath: plan.basePath })
    },
    prompts: prompts as PromptBroker,
    openInstanceView: async (instance, url) => {
      // T8 修正:先注入 Cookie 再 loadURL(§6.2),顺序由此编排保证 ——
      // 旧版先 openInstanceWindow(内部立刻加载)、之后才注入,顺序被反转。
      // 接线计划(origin/basePath/cookie)由可测的纯函数单点推导(评审反复指出的装配层盲区)。
      const plan = buildOpenViewPlan(url, auth?.sessionCookie(instance.id) ?? null)
      await openInstanceViewFlow(
        {
          // 开窗但**不自动加载**:加载由编排在注入之后执行
          createWindow: () =>
            openInstanceWindow({
              instanceId: instance.id,
              title: instance.name,
              url,
              autoLoad: false
            }),
          installIntercept: (win) => {
            const targetSession = win.webContents.session
            if (!shouldInstallIntercept(targetSession)) return
            targetSession.webRequest.onHeadersReceived((details, callback) => {
              // T9-1:basePath 必须来自 plan —— 网关 302 到的是 `<basePath>/login`,
              // 默认 '/' 只能匹配根路径实例,带路径的实例(如 /dsh)永不产生信号
              const signal = classifyViewResponse(plan, {
                statusCode: details.statusCode,
                headers: details.responseHeaders ?? {},
                resourceType: details.resourceType
              })
              if (signal) {
                // T9:会话失效 → 先静默重探(带已存 Cookie 自动恢复);仍失败才由 auth-panel 接手
                if (signal === 'session-expired' && auth && !reprobeInFlight.has(instance.id)) {
                  reprobeInFlight.add(instance.id)
                  void auth
                    .probe(instance.id)
                    .catch((error: unknown) => console.error('[main] 静默重探失败：', error))
                    .finally(() => reprobeInFlight.delete(instance.id))
                }
                // 只发给 hub 窗口:实例窗口无 preload,收到也无消费者
                if (hubWindow && !hubWindow.isDestroyed()) {
                  hubWindow.webContents.send(AUTH_IPC.signal, {
                    instanceId: instance.id,
                    signal,
                    at: new Date().toISOString()
                  })
                }
              }
              callback({ responseHeaders: details.responseHeaders ?? {} })
            })
          }
        },
        {
          url: plan.url,
          origin: plan.origin,
          basePath: plan.basePath,
          // origin 不可解析时 plan.cookie 已为 null(避免写坏分区 Cookie)
          cookie: plan.cookie
        }
      )
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