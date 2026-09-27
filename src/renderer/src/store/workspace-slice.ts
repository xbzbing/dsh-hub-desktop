/** 工作区导航、选中、向导与设置页开合分片。 */
import type { SliceCreator, WorkspaceSlice } from './types'
import {
  createNavigationGuard,
  suspendForWizardPatch,
  toDetailPatch,
  toDisconnectedPatch,
  toOpenPatch,
  toOpeningPatch,
  toSettingsPatch
} from '../lib/workspace-navigation'

/** 工作区导航代守卫：换视图递增代号，过期 openView 响应据此自我作废。 */
const navigation = createNavigationGuard()

/** 正在等待主进程 openView 返回的实例；状态事件不得对同一实例重复触发打开。 */
let openViewInFlight: string | null = null

/** 供 instance slice 的 applyStatus 判定「在途打开」用（跨分片只读）。 */
export function workspaceOpenInFlight(): string | null {
  return openViewInFlight
}

export const createWorkspaceSlice: SliceCreator<WorkspaceSlice> = (set, get) => ({
  selection: null,
  workspaceOpen: false,
  workspaceOpening: false,
  workspaceSuspended: false,
  workspaceConnected: {},
  wizardOpen: false,
  wizardExistingSpaceId: null,
  settingsOpen: false,
  pendingOpen: [],

  setWorkspaceOpen: (open) => set({ workspaceOpen: open, workspaceOpening: false }),

  // 实例与总览导航优先于设置页：否则 settingsOpen 一直为 true，侧栏点击看似
  // 改了 selection，App 却始终渲染 SettingsView，用户被困在设置页。
  select: (id) => {
    navigation.bump()
    void window.dshHub?.runtime?.hideView()
    // 挂起标记属于换 selection 前被遮挡的工作区；待打开标记同理——切走后
    // 不再等该实例启动完成，否则 running 事件会把界面强行拽回工作区。
    set(toDetailPatch(id))
  },

  openDetail: (id) => {
    void get().ensureRecord(id)
    get().select(id)
  },

  openWorkspace: async (id) => {
    // 已在同一实例的工作区内时不重开:重开会先隐藏原生视图,而重开请求若被
    // 主进程按同实例去重合并,渲染层不会再回传内容区边界,视图会停在零尺寸。
    if (get().selection === id && get().workspaceOpen) return
    const generation = navigation.begin()
    openViewInFlight = id
    try {
      void window.dshHub?.runtime?.hideView()
      set(toOpeningPatch(id))
      const result = await window.dshHub?.runtime.openView(id)
      // A later selection/open request owns the native view. Stale responses only stop themselves.
      if (!navigation.isCurrent(generation) || get().selection !== id) return
      if (result?.ok) {
        set((state) => toOpenPatch(id, state.workspaceConnected))
        return
      }
      set({ workspaceOpening: false })
      if (result) get().toast('err', get().t('detail.openViewFailed'), result.message)
    } finally {
      if (openViewInFlight === id) openViewInFlight = null
    }
  },

  disconnectWorkspace: async (id) => {
    const generation = navigation.begin()
    const result = await window.dshHub?.runtime.disconnectView(id)
    if (!navigation.isCurrent(generation)) return
    if (!result?.ok) {
      if (result) get().toast('err', get().t('detail.openViewFailed'), result.message)
      return
    }
    set((state) => toDisconnectedPatch(id, state.workspaceConnected))
    get().toast('ok', get().t('detail.disconnected'))
  },

  openFromSidebar: (id) => {
    const instance = get().instances.find((item) => item.id === id)
    const status = get().statuses[id]?.status ?? instance?.runtimeStatus
    if (status === 'error') {
      get().select(id)
      return
    }
    if (status === 'starting') {
      navigation.bump()
      void window.dshHub?.runtime?.hideView()
      set(toOpeningPatch(id))
      return
    }
    void get().openWorkspace(id)
  },

  setWizardOpen: (open) => {
    const state = get()
    if (!open) set({ wizardExistingSpaceId: null })
    if (open) {
      const suspendWorkspace = state.workspaceOpen && state.selection !== null
      if (suspendWorkspace) {
        navigation.bump()
        // WebContentsView 是独立于 React DOM 的原生子视图；确认隐藏后才挂载向导，
        // 否则它会覆盖新建实例弹窗。
        set(suspendForWizardPatch())
        void Promise.resolve(window.dshHub?.runtime?.hideView()).finally(() => {
          if (!get().wizardOpen) set({ wizardOpen: true })
        })
        return
      }
      set({ wizardOpen: true })
      return
    }

    const resumeId = state.workspaceSuspended && state.selection !== null ? state.selection : null
    set({ wizardOpen: false, ...(resumeId !== null ? { workspaceSuspended: false } : {}) })
    if (!resumeId) return
    void window.dshHub?.runtime.openView(resumeId).then((result) => {
      if (result?.ok && get().selection === resumeId && !get().wizardOpen && !get().settingsOpen) {
        set({ workspaceOpen: true })
      }
    })
  },

  createWithExistingSpace: (id) => {
    set({ wizardExistingSpaceId: id, settingsOpen: false })
    get().setWizardOpen(true)
  },

  setSettingsOpen: (open) => {
    if (open) {
      navigation.bump()
      void window.dshHub?.runtime?.hideView()
    }
    // 打开设置页即放弃当前选中,被遮挡工作区不再有可恢复的目标,挂起与待打开
    // 标记一并清除——否则实例启动完成会强制切回工作区、关掉设置页。
    set(toSettingsPatch(open))
  },

  setPendingOpen: (id) => set((state) => ({ pendingOpen: [...state.pendingOpen, id] }))
})
