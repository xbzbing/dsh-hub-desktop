/**
 * 渲染层状态(实现计划 §5.2 zustand 切片;T3 先做实例/状态/选中/主题/浮层,
 * auth 与工作区切片随 T7/T5 追加)。
 */
import { create } from 'zustand'
import type { InstanceRecord, InstanceStatusEvent, InstanceSummary } from '@shared/contracts'
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
  /** 首次列表是否已加载(加载中展示骨架屏,不出现空白闪烁 —— R6) */
  loaded: boolean
  instances: InstanceSummary[]
  /** 详情缓存:进入详情页时按需 get */
  records: Record<string, InstanceRecord>
  /** 运行时状态事件(id → 最新事件) */
  statuses: Record<string, InstanceStatusEvent>
  /** 当前选中(侧边栏),null = 回到总览 */
  selection: string | null
  rail: boolean
  theme: 'light' | 'dark'
  wizardOpen: boolean
  /** T11 设置页是否打开(与实例选中互斥展示) */
  settingsOpen: boolean
  /** 向导创建后待自动打开的实例集合(多个实例并发启动时各自独立) */
  pendingOpen: string[]
  /** 主进程 userData 路径(app:info 快照;详情页展示实例数据目录用) */
  userDataPath: string | null
  toasts: ToastItem[]
  /** T11 非敏感偏好(主进程 settings.json 是真理源) */
  settings: Settings
  /** 实际生效的语言(偏好 + 系统语言推断后的结果) */
  language: Language
  /** 当前语言的翻译函数(组件统一从这里取文案) */
  t: Translator

  load: () => Promise<void>
  refreshList: () => Promise<void>
  applyStatus: (event: InstanceStatusEvent) => void
  ensureRecord: (id: string) => Promise<InstanceRecord | null>
  select: (id: string | null) => void
  toggleRail: () => void
  toggleTheme: () => void
  setWizardOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  /** T11:跟随系统明暗变化(仅 theme='system' 生效);返回取消订阅函数 */
  subscribeSystemTheme: () => () => void
  setPendingOpen: (id: string) => void
  toast: (kind: ToastKind, title: string, detail?: string) => void
  dismissToast: (id: number) => void
  /** T11:从主进程拉取偏好并应用(启动时调用) */
  hydrateSettings: () => Promise<void>
  /** T11:更新偏好(落盘 + 立即生效) */
  updateSettings: (patch: Partial<Settings>) => Promise<void>
}

let toastSeq = 0

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
  rail: false,
  theme: initialTheme(),
  wizardOpen: false,
  settingsOpen: false,
  pendingOpen: [],
  userDataPath: null,
  toasts: [],
  settings: DEFAULT_SETTINGS,
  language: initialLanguage(),
  t: createTranslator(initialLanguage()),

  /**
   * 订阅系统明暗变化(复审 R7):`theme: 'system'` 此前只在启动时解析一次,
   * 运行中改系统外观不会跟随。回调里只重算「实际生效的明暗」,不改偏好本身。
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
    // 失败必须抛出:此前静默 return 让设置页「无论成败都提示已保存」(复审 R5),
    // 用户以为改动生效,实际被丢弃。
    // 文案由调用方经 t() 呈现;store 内不留硬编码文案(走查护栏逐行扫描)
    if (!result) throw new Error('settings-unavailable')
    if (!result.ok) throw new Error(result.message)
    const settings = result.value
    const language = resolveLanguage(settings.language, navigator.language)
    applyTheme(resolveTheme(settings.theme))
    set({ settings, language, theme: resolveTheme(settings.theme), t: createTranslator(language) })
  },

  load: async () => {
    await get().hydrateSettings()
    // 系统主题订阅只需一次;theme 变化由回调内部判定
    get().subscribeSystemTheme()
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

  applyStatus: (event) => {
    set((state) => {
      const removed = event.status === 'stopped'
      const statuses = { ...state.statuses }
      if (removed) delete statuses[event.id]
      else statuses[event.id] = event
      // 向导创建后:运行即自动打开视图(「创建→安装→启动→健康→开窗」);
      // 失败/停止则移出待开集合,避免悬挂
      let pendingOpen = state.pendingOpen
      if (pendingOpen.includes(event.id)) {
        if (event.status === 'running') {
          pendingOpen = pendingOpen.filter((id) => id !== event.id)
          // 打开失败要可见(评审 N9):此前 void 吞掉结果,用户只看到「已连接但没窗口」
          void window.dshHub?.runtime.openView(event.id).then((result) => {
            if (result && !result.ok) {
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

  select: (id) => set({ selection: id }),

  toggleRail: () => set((state) => ({ rail: !state.rail })),

  toggleTheme: () => {
    // 只改本地状态会让灯箱(设置页高亮)与偏好分叉:重启后 hydrateSettings 会把选择覆盖回去。
    // 因此走 updateSettings(落盘 + 立即生效),本地 applyTheme 由它统一负责。
    const next = get().theme === 'light' ? 'dark' : 'light'
    void get().updateSettings({ theme: next })
  },

  setWizardOpen: (open) => set({ wizardOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open, ...(open ? { selection: null } : {}) }),

  setPendingOpen: (id) => set((state) => ({ pendingOpen: [...state.pendingOpen, id] })),

  toast: (kind, title, detail) => {
    const id = ++toastSeq
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, title, detail }] }))
    setTimeout(() => get().dismissToast(id), 5000)
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
}))