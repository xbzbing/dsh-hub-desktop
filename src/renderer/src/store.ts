/**
 * 渲染层状态(实现计划 §5.2 zustand 切片;T3 先做实例/状态/选中/主题/浮层,
 * auth 与工作区切片随 T7/T5 追加)。
 */
import { create } from 'zustand'
import type { InstanceRecord, InstanceStatusEvent, InstanceSummary } from '@shared/contracts'

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
  /** 向导创建后待自动打开的实例集合(多个实例并发启动时各自独立) */
  pendingOpen: string[]
  toasts: ToastItem[]

  load: () => Promise<void>
  refreshList: () => Promise<void>
  applyStatus: (event: InstanceStatusEvent) => void
  ensureRecord: (id: string) => Promise<InstanceRecord | null>
  select: (id: string | null) => void
  toggleRail: () => void
  toggleTheme: () => void
  setWizardOpen: (open: boolean) => void
  setPendingOpen: (id: string) => void
  toast: (kind: ToastKind, title: string, detail?: string) => void
  dismissToast: (id: number) => void
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

export const useAppStore = create<AppState>()((set, get) => ({
  loaded: false,
  instances: [],
  records: {},
  statuses: {},
  selection: null,
  rail: false,
  theme: initialTheme(),
  wizardOpen: false,
  pendingOpen: [],
  toasts: [],

  load: async () => {
    applyTheme(get().theme)
    // 平台信息(隐藏标题栏布局 / 平台差异化)由主进程快照提供
    const info = await window.dshHub?.getInfo()
    if (info?.ok) document.documentElement.dataset.platform = info.value.platform
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
          void window.dshHub?.runtime.openView(event.id)
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
    const theme = get().theme === 'light' ? 'dark' : 'light'
    applyTheme(theme)
    set({ theme })
  },

  setWizardOpen: (open) => set({ wizardOpen: open }),

  setPendingOpen: (id) => set((state) => ({ pendingOpen: [...state.pendingOpen, id] })),

  toast: (kind, title, detail) => {
    const id = ++toastSeq
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, title, detail }] }))
    setTimeout(() => get().dismissToast(id), 5000)
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
}))