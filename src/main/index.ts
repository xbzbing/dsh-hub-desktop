import {
  app,
  BrowserWindow,
  dialog,
  protocol,
  safeStorage,
  session,
  shell,
  nativeTheme
} from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerRendererAssets } from './renderer-assets'
import type {
  AuthPhase,
  InstanceRuntimeStatus,
  InstanceStatusEvent
} from '@shared/contracts'
import { AUTH_IPC, INSTANCE_STATUS_EVENT } from '@shared/contracts'
import { registerIpc } from './ipc/register'
import type { AuthProbeController } from './ipc/register'
import { createLocalRuntime } from './local-runtime/local-runtime'
import type { LocalRuntimeManager } from './local-runtime/local-runtime'
import { createExternalDshScanner } from './local-runtime/external-dsh'
import { createRuntimeInstaller } from './local-runtime/runtime-installer'
import { createPathProbe } from './local-runtime/runtime-source'
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
import { isEmptyPatch, runtimeWritebackPatch } from './registry/runtime-writeback'
import { createVault } from './vault/vault'
import { createAuditLog } from './audit/audit-log'
import { createSettingsStore } from './settings/settings-store'
import { createHubTray, updateTrayStatus } from './tray'
import type { HubTrayLabels } from './tray'
import { createTranslator } from '@shared/i18n'
import { resolveLanguage } from '@shared/settings'
import type { Tray } from 'electron'
import type { SettingsStore } from './settings/settings-store'
import { createNativeSettingsApplier } from './shell/native-settings'
import { applyNativeThemeSource } from './shell/native-theme'
import { createHubNativePorts } from './shell/native-ports'
import type { HubNativePorts } from './shell/native-ports'
import { handleWindowClose } from './shell/close-to-tray'
import { createStatusNotifier } from './shell/status-notifier'
import { createDataDirOpener } from './shell/open-data-dir'
import { createGracefulQuit } from './shell/graceful-quit'
import { mapAuthTransition, mapRuntimeTransition } from './audit/audit-mapping'
import type { Vault } from './vault/vault'
import type { Settings } from '@shared/settings'
import type { AuditLog } from './audit/audit-log'
import { createWorkspaceHost } from './workspace-host'
import { createWorkspaceTooltipHost } from './workspace-tooltip'

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
 * 仅当不使用 Vite dev server 时注入（dev 由 HMR 自行管理资源，注入会打断热更新）。
 * 不依赖 isPackaged：E2E 以未打包形态启动但无 dev server，同样会走到注入路径，让 CSP 可被冒烟覆盖。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

/**
 * 数据目录可被 `DSH_HUB_DATA_DIR` 覆盖（须在 ready 前生效）。
 * 也便于在受限环境下把 userData 指到可写位置（如 CI 沙箱）。
 */
const userDataOverride = process.env['DSH_HUB_DATA_DIR']?.trim()
if (userDataOverride) app.setPath('userData', userDataOverride)

/**
 * 实例窗口没有 preload，收到也无消费者；`auth:state` 仍广播（详情页可能在任一窗口）。
 */
let hubWindow: BrowserWindow | null = null
const workspaceHost = createWorkspaceHost(
  () => hubWindow,
  () => resolveLanguage(settingsRef?.read().language, app.getLocale())
)
const workspaceTooltipHost = createWorkspaceTooltipHost(() => hubWindow)


let vault: Vault | null = null
let audit: AuditLog | null = null

/**
 * (「关闭时最小化到托盘」),而窗口创建早于/独立于装配顺序。
 */
let settingsRef: SettingsStore | null = null

/**
 */
let nativePorts: HubNativePorts<Tray> | null = null

/**
 * 托盘图标路径。
 *
 * 打包后资源不在 `out/main` 的相对位置,而是由 electron-builder 经
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

/** 从托盘退出：`before-quit` 先标记退出，再放行窗口关闭。 */
function quitApp(): void {
  app.quit()
}

/**
 * 放在主进程而不是渲染层:即使没有窗口(后台启动)审计也要完整。
 */
/** auth 注册表引用(供会话持久化读取 Cookie;装配时赋值) */
let authRegistryRef: AuthRegistry | null = null

const lastAuthState = new Map<string, { phase: AuthPhase; lockedForMs: number; lastErrorCode: string | null }>()
const lastRuntimeState = new Map<string, InstanceRuntimeStatus>()

function auditWrite(entry: Parameters<AuditLog['write']>[0]): void {
  void audit?.write(entry).catch(() => undefined)
}

/**
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
let authProbeController: AuthProbeController | null = null

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

  // Hub renderer 不接受 popup；外部跳转必须由显式、受校验的用户操作触发。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault()
  })
  // Command+R 只重启 renderer，主进程管理的 WebContentsView 不会自动销毁。
  // 在 Hub 顶层重新导航时立即撤销旧工作区边界，避免它覆盖刷新后恢复的侧边栏。
  win.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    workspaceTooltipHost.hide()
    workspaceHost.hide()
  })

  if (isDev && rendererDevUrl) void win.loadURL(rendererDevUrl)
  else void win.loadURL(`${RENDERER_ORIGIN}/index.html`)

  // 判定与拦截动作在 `shell/close-to-tray.ts`(三审 Finding 2):
  // 「托盘是否存在」必须**实时查询**真实端口,不能写死 —— 硬编码 `true` 会让
  // 没有托盘时也隐藏窗口,应用从此叫不回来(只剩 macOS Dock)。
  win.on('close', (event) => {
    handleWindowClose(event, {
      settings: () => settingsRef?.read() ?? null,
      // 「托盘是否存在」由端口自己回答(存在性的唯一真理源),这里不做二次判断
      trayAvailable: () => nativePorts?.trayExists() === true,
      isQuitting: () => quitting,
      hideWindow: () => win.hide()
    })
  })

  win.on('closed', () => {
    workspaceHost.closeAll()
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
  registerRendererAssets({
    rendererRoot: join(__dirname, '../renderer'),
    rendererDevUrl,
    isRendererOrigin
  })
}

/** 运行中的本地实例 / SSH 隧道管理器（退出前需回收进程树，故提到模块级） */
let runtime: LocalRuntimeManager | null = null
let tunnels: SshTunnelManager | null = null
let httpEndpoints: HttpEndpointManager | null = null
let prompts: PromptBroker | null = null
let auth: AuthRegistry | null = null
let quitting = false

const gracefulQuit = createGracefulQuit({
  onStart: () => {
    quitting = true
  },
  cleanup: async () => {
    const recycling: Array<Promise<void>> = []
    if (runtime) {
      recycling.push(runtime.stopAll().catch((error: unknown) => console.error('[main] 停止实例失败：', error)))
    }
    if (tunnels) {
      recycling.push(tunnels.stopAll().catch((error: unknown) => console.error('[main] 停止隧道失败：', error)))
    }
    if (httpEndpoints) {
      recycling.push(
        httpEndpoints.stopAll().catch((error: unknown) => console.error('[main] 停止 HTTP 实例失败：', error))
      )
    }
    await Promise.all(recycling)
  },
  onError: (error) => console.error('[main] 退出清理失败：', error),
  // app.quit() 会重新进入 before-quit；完成清理后必须直接结束进程，确保一次 ⌘Q 即退出。
  exit: (code) => app.exit(code)
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else {
  app.on('second-instance', () => showHubWindow())
}

void app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  registerRendererProtocol()

  const dataRoot = app.getPath('userData')
  // 注册表落盘位置：<userData>/registry/instances.json（+ 滚动备份 + 损坏隔离）
  const instanceStore = createInstanceStore({ dir: join(dataRoot, 'registry') })
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
  const settings = createSettingsStore({ dir: dataRoot })
  settingsRef = settings

  /**
   * 把偏好施加到原生层(开机自启)。失败只记日志:
   * 偏好已落盘,系统层面设置失败不该让设置页报错。
   */
  /**
   * 施加原生设置。
   *
   * 「该做哪些动作」由纯函数 `planNativeSettings` 决定,「动作有没有真的落到
   * electron」由注入端口的 `createNativeSettingsApplier` 保证 —— 两者都有单测
   */
  const ports = createHubNativePorts<Tray>({
    // 图标/文案都是**动态取值**:语言或运行中实例数变了,刷新时必须重新求值
    iconPath: trayIconPath,
    labels: trayLabels,
    createTray: (options) => createHubTray(options),
    refreshTrayMenu: (tray, labels, onShow, onQuit) =>
      updateTrayStatus(tray, labels, onShow, onQuit),
    applyLoginItem: (value) => app.setLoginItemSettings(value),
    onShow: showHubWindow,
    onQuit: quitApp,
    onError: (error, action) => console.error('[main] 应用原生设置失败：', action, error)
  })
  nativePorts = ports
  const nativeApplier = createNativeSettingsApplier(ports)

  const applyNativeSettings = (current: Settings, changedKeys: readonly (keyof Settings)[]): void => {
    nativeApplier.apply(current, { changedKeys })
    if (changedKeys.includes('workspaceCacheSize')) {
      workspaceHost.setCacheLimit(current.workspaceCacheSize)
    }
    if (changedKeys.includes('language')) {
      workspaceHost.setLocale()
    }
    if (changedKeys.includes('theme')) {
      applyNativeThemeSource(current.theme, nativeTheme)
    }
  }

  // 这里只注入「偏好/语言」两个取值端口(三审 Finding 2)
  const notifier = createStatusNotifier({
    readSettings: () => settings.read(),
    locale: () => app.getLocale(),
    onError: (error) => console.error('[main] 发送系统通知失败：', error)
  })

  // 目录在此解析(`DSH_HUB_DATA_DIR` 覆盖已在文件顶部生效,故 userData 即权威值)。
  const dataDirOpener = createDataDirOpener({
    dataDir: () => app.getPath('userData'),
    openPath: (path) => shell.openPath(path)
  })

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
  workspaceHost.setCacheLimit(settings.read().workspaceCacheSize)
  applyNativeThemeSource(settings.read().theme, nativeTheme)
  nativeApplier.apply(settings.read(), { startup: true })
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
  // 确认用原生对话框(始终可用,含托盘启动场景;文案无凭据);拒绝则该次启动取消。
  const pathProbe = createPathProbe()
  runtime = createLocalRuntime({
    installer,
    dataRoot,
    pathProbe,
    confirmDownload: (version) =>
      dialog
        .showMessageBox({
          type: 'question',
          title: 'DSH Hub',
          message: '未找到可复用的 dsh 运行时',
          detail: `hub 隔离目录与本机 PATH 上都没有可用的 dsh，需要下载 @deepseek-ai/dsh@${version}（首次下载可能较慢）。是否继续？`,
          buttons: ['下载并启动', '取消'],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        })
        .then((result) => result.response === 0)
  })

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
  httpEndpoints = createHttpEndpoints()

  // 状态推进（local + ssh 共用同一通道）→ 广播到所有窗口；把实际端口/版本回写注册表
  // （transport 感知：ssh 的「端口」是隧道本地口 localPort，local 的才是监听 port）；
  // 回收已停止实例的窗口
  const handleStatusEvent = (event: InstanceStatusEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(INSTANCE_STATUS_EVENT, event)
    }
    const previousStatus = lastRuntimeState.get(event.id) ?? null
    for (const entry of mapRuntimeTransition(
      event.id,
      previousStatus === null ? null : { status: previousStatus },
      { status: event.status }
    )) {
      auditWrite(entry)
    }
    // 写在不可测的闭包里,删掉后三关全绿);失败已在内部收敛为日志,绝不打断状态流。
    notifier.notify(event, previousStatus)
    lastRuntimeState.set(event.id, event.status)
    // 托盘菜单的状态行跟随实例变化刷新(只有托盘**确实存在**时才刷新)
    const tray = nativePorts?.currentTray()
    if (tray && nativePorts) {
      try {
        nativePorts.updateTray()
      } catch (error) {
        console.error('[main] 刷新托盘菜单失败：', error)
      }
    }
    if (event.status === 'running' && (event.port !== undefined || event.version !== undefined)) {
      void instanceStore
        .get(event.id)
        .then((record) => {
          // 回写策略集中在纯函数里(可穷举测试):只有 hub 来源回写版本;
          // 而 store 拒绝空补丁(`补丁不能为空`)→ 必须在此跳过,否则每次接管都报错。
          const patch = runtimeWritebackPatch(event, record?.transport)
          if (isEmptyPatch(patch)) return null
          return instanceStore.update(event.id, patch)
        })
        .catch((error: unknown) => console.error('[main] 回写实例运行信息失败：', error))
    }
    if (event.status === 'stopped') workspaceHost.close(event.id)
  }
  runtime.onStatus(handleStatusEvent)
  tunnels.onStatus(handleStatusEvent)
  httpEndpoints.onStatus(handleStatusEvent)

  auth = createAuthRegistry({
    restore: async (instanceId, client) => {
      if (!vault) return
      await restoreSessionFromVault({ vault }, instanceId, client)
    },
    resolveEndpoint: async (instanceId) => {
      const record = await instanceStore.get(instanceId)
      if (!record) return null
      // 只取**实时**隧道端口:注册表的 localPort 可能已陈旧(隧道重启会重新分配),
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
      const previous = lastAuthState.get(instanceId) ?? null
      for (const entry of mapAuthTransition(instanceId, previous, state)) {
        auditWrite(entry)
      }
      lastAuthState.set(instanceId, {
        phase: state.phase,
        lockedForMs: state.lockedForMs,
        lastErrorCode: state.lastErrorCode
      })
      if (state.phase === 'connected') void persistSessionIfOptedIn(instanceId)
    }
  })

  authRegistryRef = auth

  authProbeController = registerIpc(instanceStore, {
    runtime,
    tunnels,
    http: httpEndpoints,
    auth,
    externalDsh: createExternalDshScanner(),
    pathProbe,
    vault: vault as Vault,
    settings,
    audit: auditWrite,
    onSettingsChanged: applyNativeSettings,
    openDataDir: () => dataDirOpener.open(),
    hideInstanceView: () => workspaceHost.hide(),
    closeInstanceView: (instanceId) => workspaceHost.disconnect(instanceId),
    setInstanceViewBounds: (bounds) => workspaceHost.setBounds(bounds),
    showInstanceTooltip: (tooltip) => workspaceTooltipHost.show(tooltip),
    hideInstanceTooltip: () => workspaceTooltipHost.hide(),
    clearPartitionSession: async (instanceId) => {
      const record = await instanceStore.get(instanceId)
      // 否则「先停隧道再清 Cookie」会静默 no-op
      const plan = planPartitionClear(record, tunnels?.statusOf(instanceId)?.port)
      if (!plan) return
      const target = session.fromPartition(plan.partition)
      await clearSessionCookie(target.cookies, { origin: plan.origin, basePath: plan.basePath })
    },
    prompts: prompts as PromptBroker,
    openInstanceView: async (instance, url) => {
      // Write the session Cookie before navigation starts.
      const plan = buildOpenViewPlan(url, auth?.sessionCookie(instance.id) ?? null)
      await openInstanceViewFlow(
        {
          createWindow: () => workspaceHost.prepare(instance.id, url),
          installIntercept: (win) => {
            const targetSession = win.webContents.session
            if (!shouldInstallIntercept(targetSession)) return
            targetSession.webRequest.onHeadersReceived((details, callback) => {
              // 默认 '/' 只能匹配根路径实例,带路径的实例(如 /dsh)永不产生信号
              const signal = classifyViewResponse(plan, {
                statusCode: details.statusCode,
                headers: details.responseHeaders ?? {},
                resourceType: details.resourceType
              })
              if (signal) {
                if (signal === 'session-expired' && auth && !reprobeInFlight.has(instance.id)) {
                  reprobeInFlight.add(instance.id)
                  void authProbeController
                    ?.probe(instance.id)
                    .then((state) => {
                      if (state?.phase === 'connected') workspaceHost.reload()
                    })
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
    // macOS 惯例：点击 Dock 图标时把窗口带回前台。窗口可能仍然存在但处于隐藏状态
    // （「关闭时最小化到托盘」），此时只判断「有没有窗口」会让点击毫无反应。
    showHubWindow()
  })

  app.on('browser-window-created', (_event, win) => {
    win.on('closed', () => {
      if (BrowserWindow.getAllWindows().filter((other) => !other.isDestroyed()).length === 0) {
        prompts?.cancelAll()
      }
    })
  })
})

app.on('before-quit', (event) => {
  workspaceTooltipHost.close()
  gracefulQuit.handleBeforeQuit(event)
})

app.on('window-all-closed', () => {
  // 全部窗口关闭:先收敛待答请求(macOS 进程可能驻留,请求不能悬着)
  prompts?.cancelAll()
  if (process.platform !== 'darwin') app.quit()
})