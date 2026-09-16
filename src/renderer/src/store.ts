/** 渲染层 Zustand 状态。 */
import { create } from 'zustand'
import type {
  AuthPhase,
  InstanceRecord,
  InstanceStatusEvent,
  InstanceSummary
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
  rail: false,
  theme: initialTheme(),
  wizardOpen: false,
  settingsOpen: false,
  pendingOpen: [],
  userDataPath: null,
  authPhases: {},
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
      set({ instances: result.value })
    }
  },

  applyAuthPhase: (instanceId, phase) => {
    set((state) => ({ authPhases: { ...state.authPhases, [instanceId]: phase } }))
  },

  applyStatus: (event) => {
    set((state) => {
      const removed = event.status === 'stopped'
      const statuses = { ...state.statuses }
      if (removed) delete statuses[event.id]
      else statuses[event.id] = event
      // 运行后自动打开工作区；失败或停止时移除待打开记录。
      let pendingOpen = state.pendingOpen
      if (pendingOpen.includes(event.id)) {
        if (event.status === 'running') {
          pendingOpen = pendingOpen.filter((id) => id !== event.id)
          // 打开工作区失败时显示错误。
          void window.dshHub?.runtime.openView(event.id).then((result) => {
            if (result?.ok) useAppStore.getState().setWorkspaceOpen(true)
            else if (result) {
              const t = useAppStore.getState().t
              useAppStore.getState().toast('err', t('detail.openViewFailed'), result.message)
            }
          })
        } else if (event.status === 'error' || event.status === 'stopped') {
          pendingOpen = pendingOpen.filter((id) => id !== event.id)
        }
      }
      return { statuses, pendingOpen }
    })
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
    void window.dshHub?.runtime?.hideView()
    set({ selection: id, workspaceOpen: false, settingsOpen: false })
  },

  setWorkspaceOpen: (open) => set({ workspaceOpen: open }),

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

  setWizardOpen: (open) => set({ wizardOpen: open }),
  setSettingsOpen: (open) => {
    if (open) void window.dshHub?.runtime?.hideView()
    set({ settingsOpen: open, workspaceOpen: false, ...(open ? { selection: null } : {}) })
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