/** 渲染层 Zustand 状态。 */
import { create } from 'zustand'
import type {
  AuthPhase,
  InstanceRecord,
  InstanceStatusEvent,
  InstanceSummary,
  VaultStatusSnapshot
} from '@shared/contracts'
import { DEFAULT_SETTINGS, resolveLanguage } from '@shared/settings'
import type { Language, Settings, Theme } from '@shared/settings'
import { createTranslator } from '@shared/i18n'
import type { Translator } from '@shared/i18n'

export interface ToastItem {
  id: number
  kind: 'ok' | 'info' | 'warn' | 'err'
  title: string
  detail?: string
}

export type ToastKind = ToastItem['kind']

interface AppState {
  /** 首次列表是否已加载；加载时显示骨架屏。 */
  loaded: boolean
  instances: InstanceSummary[]
  /** 详情缓存:进入详情页时按需 get */
  records: Record<string, InstanceRecord>
  /** 运行时状态事件(id → 最新事件) */
  statuses: Record<string, InstanceStatusEvent>
  /** 当前选中(侧边栏),null = 回到总览 */
  selection: string | null
  /** 当前是否有主进程托管的内嵌工作区覆盖内容区。 */
  workspaceOpen: boolean
  /** 正在检测并打开实例工作区；完成前保持加载中间页而不是切换详情。 */
  workspaceOpening: boolean
  /** 向导暂时遮挡了主进程工作区；关闭向导后恢复已缓存视图。 */
  workspaceSuspendedForWizard: boolean
  setWorkspaceOpen: (open: boolean) => void
  rail: boolean
  theme: 'light' | 'dark'
  wizardOpen: boolean
  /** 设置页是否打开；打开时不显示实例详情。 */
  settingsOpen: boolean
  /** 向导创建后待自动打开的实例集合(多个实例并发启动时各自独立) */
  pendingOpen: string[]
  /** 主进程 userData 路径(app:info 快照;详情页展示实例数据目录用) */
  userDataPath: string | null
  /**
   * 各实例的认证相位快照，用于控制详情页认证操作的可见性。
   * 未收到事件的实例不在 map 中。
   */
  authPhases: Record<string, AuthPhase>
  /** 写入/清除实例的认证相位(登出后为最新相位,无需特判) */
  applyAuthPhase: (instanceId: string, phase: AuthPhase) => void
  /**
   * 凭据保险库快照。登录成功时主进程会**静默**写入凭据，渲染层不会收到任何事件，
   * 因此必须由登录流程显式刷新，否则详情页的「凭据存储」会一直停留在旧状态。
   */
  vaultStatus: VaultStatusSnapshot | null
  setVaultStatus: (status: VaultStatusSnapshot) => void
  refreshVault: () => Promise<void>
  toasts: ToastItem[]
  /** 非敏感偏好，由主进程 settings.json 保存。 */
  settings: Settings
  /** 实际生效的语言(偏好 + 系统语言推断后的结果) */
  language: Language
  /** 当前语言的翻译函数(组件统一从这里取文案) */
  t: Translator

  load: () => Promise<void>
  refreshList: () => Promise<void>
  applyStatus: (event: InstanceStatusEvent) => void
  ensureRecord: (id: string) => Promise<InstanceRecord | null>
  /** 强制从主进程重读该实例(绕过缓存)—— 编辑保存后刷新详情必须用它:
      `ensureRecord` 只在缓存缺失时拉取,会把陈旧记录留在 store 里 */
  reloadRecord: (id: string) => Promise<void>
  select: (id: string | null) => void
  /** 选择实例后打开其工作区；失败时保留详情，提示用户原因。 */
  openWorkspace: (id: string) => Promise<void>
  /** 侧栏入口：处于错误状态的本机实例直接展示详情，避免必然失败的启动尝试。 */
  openFromSidebar: (id: string) => void
  toggleRail: () => void
  toggleTheme: () => void
  setWizardOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  /** 订阅系统主题变化，仅在 theme='system' 时生效。 */
  subscribeSystemTheme: () => () => void
  setPendingOpen: (id: string) => void
  toast: (kind: ToastKind, title: string, detail?: string) => void
  dismissToast: (id: number) => void
  /** 从主进程读取并应用偏好。 */
  hydrateSettings: () => Promise<void>
  /** 更新并立即应用偏好。 */
  updateSettings: (patch: Partial<Settings>) => Promise<void>
}

let toastSeq = 0
/** 最近一次工作区导航意图；过期 IPC 完成不得覆盖当前实例视图。 */
let workspaceNavigationGeneration = 0

  /** 系统主题监听的取消函数，避免重复订阅。 */
let systemThemeUnsubscribe: (() => void) | null = null

function initialTheme(): 'light' | 'dark' {
  const saved = localStorage.getItem('dshhub-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('dshhub-theme', theme)
}

/** 偏好主题(system/light/dark)解析为实际明暗 */
function resolveTheme(preference: Theme): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') return preference
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 初始语言:偏好未知时先按系统语言推断,hydrate 后再以主进程为准 */
function initialLanguage(): Language {
  return resolveLanguage(null, navigator.language)
}

export const useAppStore = create<AppState>()((set, get) => ({
  loaded: false,
  instances: [],
  records: {},
  statuses: {},
  selection: null,
  workspaceOpen: false,
  workspaceOpening: false,
  workspaceSuspendedForWizard: false,
  rail: false,
  theme: initialTheme(),
  wizardOpen: false,
  settingsOpen: false,
  pendingOpen: [],
  userDataPath: null,
  authPhases: {},
  vaultStatus: null,
  toasts: [],
  settings: DEFAULT_SETTINGS,
  language: initialLanguage(),
  t: createTranslator(initialLanguage()),

  /**
   * 在 theme='system' 时随系统外观更新实际主题，不改变用户偏好。
   */
  subscribeSystemTheme: () => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return () => undefined
    const onChange = (): void => {
      const state = get()
      if (state.settings.theme !== 'system') return
      const resolved = resolveTheme('system')
      applyTheme(resolved)
      set({ theme: resolved })
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  },

  hydrateSettings: async () => {
    const result = await window.dshHub?.settings.get()
    if (!result?.ok) return
    const settings = result.value
    const language = resolveLanguage(settings.language, navigator.language)
    applyTheme(resolveTheme(settings.theme))
    set({ settings, language, theme: resolveTheme(settings.theme), t: createTranslator(language) })
  },

  updateSettings: async (patch) => {
    const result = await window.dshHub?.settings.update(patch)
    // 让调用方在保存失败时显示错误提示；store 不保留硬编码文案。
    if (!result) throw new Error('settings-unavailable')
    if (!result.ok) throw new Error(result.message)
    const settings = result.value
    const language = resolveLanguage(settings.language, navigator.language)
    applyTheme(resolveTheme(settings.theme))
    set({ settings, language, theme: resolveTheme(settings.theme), t: createTranslator(language) })
  },

  load: async () => {
    await get().hydrateSettings()
    // 重新订阅前先取消旧订阅，避免重复监听。
    systemThemeUnsubscribe?.()
    systemThemeUnsubscribe = get().subscribeSystemTheme()
    applyTheme(resolveTheme(get().settings.theme))
    // 平台信息(隐藏标题栏布局 / 平台差异化)与 userData 路径由主进程快照提供
    const info = await window.dshHub?.getInfo()
    if (info?.ok) {
      document.documentElement.dataset.platform = info.value.platform
      set({ userDataPath: info.value.userDataPath })
    }
    await get().refreshList()
    set({ loaded: true })
  },

  refreshList: async () => {
    const bridge = window.dshHub
    if (!bridge) return
    const result = await bridge.instances.list()
    if (result.ok) {
      const snapshotStatuses = result.value.reduce<Record<string, InstanceStatusEvent>>((statuses, instance) => {
        if (instance.runtimeStatus) {
          statuses[instance.id] = { id: instance.id, status: instance.runtimeStatus, at: instance.updatedAt }
        }
        return statuses
      }, {})
      // 推送事件优先于列表快照，避免列表读取期间的旧快照覆盖最新状态。
      set((state) => ({ instances: result.value, statuses: { ...snapshotStatuses, ...state.statuses } }))
    }
  },

  applyAuthPhase: (instanceId, phase) => {
    set((state) => ({ authPhases: { ...state.authPhases, [instanceId]: phase } }))
  },

  setVaultStatus: (status) => set({ vaultStatus: status }),

  refreshVault: async () => {
    const result = await window.dshHub?.vault.status()
    // 读取失败时保留上一份快照:把「已记住」翻回「未记住」是误导,且会诱使用户重复保存。
    if (result?.ok) set({ vaultStatus: result.value })
  },

  applyStatus: (event) => {
    let shouldOpen: string | null = null
    set((state) => {
      const removed = event.status === 'stopped'
      const statuses = { ...state.statuses }
      if (removed) delete statuses[event.id]
      else statuses[event.id] = event
      // 列表摘要不是详情记录的实时投影；本机运行事件已给出实际监听端口，立即更新地址。
      const instances = state.instances.map((instance) =>
        instance.id === event.id && instance.transport === 'local' && event.port !== undefined
          ? { ...instance, address: `127.0.0.1:${event.port}` }
          : instance
      )
      // 运行后自动打开工作区；失败或停止时移除待打开记录。
      let pendingOpen = state.pendingOpen
      if (pendingOpen.includes(event.id)) {
        if (event.status === 'running') {
          pendingOpen = pendingOpen.filter((id) => id !== event.id)
          shouldOpen = event.id
        } else if (event.status === 'error' || event.status === 'stopped') {
          pendingOpen = pendingOpen.filter((id) => id !== event.id)
        }
      }
      return { instances, statuses, pendingOpen }
    })
    if (shouldOpen !== null) void get().openWorkspace(shouldOpen)
  },

  ensureRecord: async (id) => {
    const cached = get().records[id]
    if (cached) return cached
    const result = await window.dshHub?.instances.get(id)
    if (result?.ok && result.value) {
      set((state) => ({ records: { ...state.records, [id]: result.value as InstanceRecord } }))
      return result.value as InstanceRecord
    }
    return null
  },

  reloadRecord: async (id) => {
    const result = await window.dshHub?.instances.get(id)
    if (result?.ok && result.value) {
      set((state) => ({ records: { ...state.records, [id]: result.value as InstanceRecord } }))
    }
  },

  // 实例与总览导航优先于设置页：否则 settingsOpen 一直为 true，侧栏点击看似
  // 改了 selection，App 却始终渲染 SettingsView，用户被困在设置页。
  select: (id) => {
    workspaceNavigationGeneration += 1
    void window.dshHub?.runtime?.hideView()
    set({ selection: id, workspaceOpen: false, workspaceOpening: false, settingsOpen: false })
  },

  openWorkspace: async (id) => {
    const generation = ++workspaceNavigationGeneration
    void window.dshHub?.runtime?.hideView()
    set({ selection: id, workspaceOpen: false, workspaceOpening: true, settingsOpen: false })
    const result = await window.dshHub?.runtime.openView(id)
    // A later selection/open request owns the native view. Stale responses only stop themselves.
    if (generation !== workspaceNavigationGeneration || get().selection !== id) return
    if (result?.ok) {
      set({ workspaceOpen: true, workspaceOpening: false })
      return
    }
    set({ workspaceOpening: false })
    if (result) get().toast('err', get().t('detail.openViewFailed'), result.message)
  },

  openFromSidebar: (id) => {
    const instance = get().instances.find((item) => item.id === id)
    const status = get().statuses[id]?.status ?? instance?.runtimeStatus
    if (instance?.transport === 'local' && status === 'error') {
      get().select(id)
      return
    }
    void get().openWorkspace(id)
  },

  setWorkspaceOpen: (open) => set({ workspaceOpen: open, workspaceOpening: false }),

  toggleRail: () => set((state) => ({ rail: !state.rail })),

  toggleTheme: () => {
    // 只改本地状态会让灯箱(设置页高亮)与偏好分叉:重启后 hydrateSettings 会把选择覆盖回去。
    // 因此走 updateSettings(落盘 + 立即生效),本地 applyTheme 由它统一负责。
    // 偏好是 system 时 get().theme 是**已解析**的值;直接持久化会把用户的
    // 「跟随系统」无声改成显式明/暗。这里显式保留 system 语义:先落盘为显式值
    // 是期望行为(用户点了切换),但失败必须可见。
    const next = get().theme === 'light' ? 'dark' : 'light'
    void get().updateSettings({ theme: next }).catch(() => {
      get().toast('err', get().t('settings.saveFailed'))
    })
  },

  setWizardOpen: (open) => {
    const state = get()
    if (open) {
      const suspendWorkspace = state.workspaceOpen && state.selection !== null
      if (suspendWorkspace) {
        workspaceNavigationGeneration += 1
        // WebContentsView 是独立于 React DOM 的原生子视图；确认隐藏后才挂载向导，
        // 否则它会覆盖新建实例弹窗。
        set({ workspaceOpen: false, workspaceOpening: false, workspaceSuspendedForWizard: true })
        void Promise.resolve(window.dshHub?.runtime?.hideView()).finally(() => {
          if (!get().wizardOpen) set({ wizardOpen: true })
        })
        return
      }
      set({ wizardOpen: true, workspaceSuspendedForWizard: false })
      return
    }

    const resumeId = state.workspaceSuspendedForWizard ? state.selection : null
    set({ wizardOpen: false, workspaceSuspendedForWizard: false })
    if (!resumeId) return
    void window.dshHub?.runtime.openView(resumeId).then((result) => {
      if (result?.ok && get().selection === resumeId && !get().wizardOpen) set({ workspaceOpen: true })
    })
  },
  setSettingsOpen: (open) => {
    if (open) {
      workspaceNavigationGeneration += 1
      void window.dshHub?.runtime?.hideView()
    }
    set({ settingsOpen: open, workspaceOpen: false, workspaceOpening: false, ...(open ? { selection: null } : {}) })
  },

  setPendingOpen: (id) => set((state) => ({ pendingOpen: [...state.pendingOpen, id] })),

  toast: (kind, title, detail) => {
    const id = ++toastSeq
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, title, detail }] }))
    setTimeout(() => get().dismissToast(id), 5000)
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
}))