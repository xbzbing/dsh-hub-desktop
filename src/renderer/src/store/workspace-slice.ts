/** 工作区导航、选中、向导与设置页开合分片。 */
import type { SliceCreator, WorkspaceSlice } from './types'
import {
  createNavigationGuard,
  suspendForWizardPatch,
  toDetailPatch,
  toDisconnectedPatch,
  toOpenPatch,
  toOpeningPatch,
  toSettingsPatch,
  toWizardClosedPatch
} from '../lib/workspace-navigation'
import { readPersistedView, writePersistedView } from '../lib/view-persistence'

/**
 * 工作区导航代守卫：换视图递增代号，过期 openView 响应据此自我作废；
 * 同时记录「正在打开的实例」，供 instance slice 的 applyStatus 判定在途打开。
 */
const navigation = createNavigationGuard()

/**
 * 加载中间页停留上限：openView 响应丢失、或依赖的 running 事件永不到达时，
 * 超时回退到详情页并提示——界面绝不停在「正在打开工作区…」。
 * 取值需小于 E2E 对打开流程的 20s 等待预算，又要给真实启动留足余量。
 */
const OPENING_TIMEOUT_MS = 10_000

/**
 * 打开成功后的可见性看守上限：openView 返回成功到主进程按边界显示视图之间
 * 还有一段异步间隔。超过这个时间仍未确认可见，就认为视图不会出现了，回退详情页。
 * 取 5s：比「加载中间页」的上限短，用户感知上仍属于打开动作的一部分。
 */
const VISIBILITY_TIMEOUT_MS = 5_000

/** 供 instance slice 的 applyStatus 判定「在途打开」用（跨分片只读）。 */
export function workspaceOpenInFlight(): string | null {
  return navigation.inFlight()
}

export const createWorkspaceSlice: SliceCreator<WorkspaceSlice> = (set, get) => {
  /**
   * 同实例在途打开：记录发起时的导航代。只有仍属当前意图的任务才能并入；
   * 已被换视图作废的任务必须重新发起，否则第二次点击会等在不会生效的任务上。
   */
  const inFlightOpens = new Map<string, { generation: number; task: Promise<void> }>()

  /** 本次加载超时兜底的定时器；携带 id+导航代，只归自己的尝试所有。 */
  let opening: { id: string; generation: number; timer: ReturnType<typeof setTimeout> } | null =
    null

  /** 武装加载超时兜底（同一时刻只保留最新一次尝试的定时器）。 */
  const armOpeningTimeout = (id: string, generation: number): void => {
    disarmOpeningTimeout()
    const timer = setTimeout(() => {
      opening = null
      if (
        navigation.isCurrent(generation) &&
        get().selection === id &&
        get().workspaceOpening &&
        !get().workspaceOpen
      ) {
        navigation.clearInFlight(id, generation)
        // 这次打开已超时：移出在途表，下一次点击必须重新发起，不能再等它。
        inFlightOpens.delete(id)
        set({ workspaceOpening: false })
        get().toast('err', get().t('detail.openViewTimeout'))
      }
    }, OPENING_TIMEOUT_MS)
    timer.unref?.()
    opening = { id, generation, timer }
  }

  /** 拆除超时兜底；只拆属于本次尝试的（过期响应不能清掉新一次的定时器）。 */
  const disarmOpeningTimeout = (id?: string, generation?: number): void => {
    if (opening === null) return
    if (id !== undefined && (opening.id !== id || opening.generation !== generation)) return
    clearTimeout(opening.timer)
    opening = null
  }

  /**
   * 可见性看守：openView 成功只说明主进程准备好并导航了视图，还要等它按内容区边界
   * 把视图显示出来。若边界始终没落到活动视图（隐藏晚于 prepare、视图被清掉等），
   * 界面会停在「已打开但内容区空白」的中间态；本定时器把它兜回详情页。
   */
  let visibility: { id: string; generation: number; timer: ReturnType<typeof setTimeout> } | null =
    null

  /** 拆除可见性看守（确认可见或换了导航目标时）。 */
  const disarmVisibility = (): void => {
    if (visibility === null) return
    clearTimeout(visibility.timer)
    visibility = null
  }

  /** 武装可见性看守：在 VISIBILITY_TIMEOUT_MS 内未确认可见就回退详情页。 */
  const armVisibility = (id: string, generation: number): void => {
    disarmVisibility()
    const timer = setTimeout(() => {
      visibility = null
      if (!navigation.isCurrent(generation)) return
      if (get().selection !== id || !get().workspaceOpen) return
      // 视图没显示出来：先清状态再隐藏，避免原生视图残留在内容区。
      set({ workspaceOpen: false, workspaceOpening: false })
      void window.dshHub?.runtime?.hideView()
      get().toast('err', get().t('detail.openViewTimeout'))
    }, VISIBILITY_TIMEOUT_MS)
    timer.unref?.()
    visibility = { id, generation, timer }
  }

  /** 一次打开事务：进入加载页 → 请求主进程打开 → 成功则显示并武装可见性看守。 */
  const runOpenWorkspace = async (id: string, generation: number): Promise<void> => {
    try {
      // 隐藏由主进程在 openView 内一并完成：渲染层再单独发 hideView 会与 prepare
      // 竞争，产生「视图已建好又被隐藏」的窗口。
      set(toOpeningPatch(id))
      armOpeningTimeout(id, generation)
      const result = await window.dshHub?.runtime.openView(id)
      // A later selection/open request owns the native view. Stale responses only stop themselves.
      if (!navigation.isCurrent(generation) || get().selection !== id) return
      if (result?.ok) {
        set((state) => toOpenPatch(id, state.workspaceConnected))
        // 视图已就绪，等 App 回传的边界被主进程接受后再确认可见。
        armVisibility(id, generation)
        return
      }
      set({ workspaceOpening: false })
      if (result) get().toast('err', get().t('detail.openViewFailed'), result.message)
    } finally {
      disarmOpeningTimeout(id, generation)
      navigation.clearInFlight(id, generation)
    }
  }

  return {
    selection: null,
    workspaceOpen: false,
    workspaceOpening: false,
    workspaceSuspended: false,
    workspaceConnected: {},
    wizardOpen: false,
    wizardExistingSpaceId: null,
    settingsOpen: false,
    pendingOpen: [],
    loginGate: [],

    setWorkspaceOpen: (open) => {
      if (!open) disarmVisibility()
      set({ workspaceOpen: open, workspaceOpening: false })
    },

    // 实例与总览导航优先于设置页：否则 settingsOpen 一直为 true，侧栏点击看似
    // 改了 selection，App 却始终渲染 SettingsView，用户被困在设置页。
    select: (id) => {
      navigation.begin()
      disarmVisibility()
      void window.dshHub?.runtime?.hideView()
      // 挂起标记属于换 selection 前被遮挡的工作区；待打开标记同理——切走后
      // 不再等该实例启动完成，否则 running 事件会把界面强行拽回工作区。
      set(toDetailPatch(id))
      writePersistedView(sessionStorage, { selection: id, settingsOpen: false })
    },

    openDetail: (id) => {
      void get().ensureRecord(id)
      get().select(id)
    },

    openWorkspace: async (id) => {
      // 已在同一实例的工作区内时不重开:重开会先隐藏原生视图,而重开请求若被
      // 主进程按同实例去重合并,渲染层不会再回传内容区边界,视图会停在零尺寸。
      if (get().selection === id && get().workspaceOpen) return
      // 同实例已有在途打开：并入那一次事务。重复点击、自动打开与手动打开并发时
      // 若各自发起一次打开，后发的那次隐藏会落在前一次 prepare 之后，把刚建好的
      // 视图清零，界面停在「已打开但内容区空白」。
      const pending = inFlightOpens.get(id)
      if (pending !== undefined && navigation.isCurrent(pending.generation)) {
        await pending.task
        return
      }
      // 已被换视图作废的任务不再并入：并入只会等来一个不会生效的结果，
      // 用户看到的是点击后毫无反应。
      const generation = navigation.begin(id)
      const task = runOpenWorkspace(id, generation)
      inFlightOpens.set(id, { generation, task })
      try {
        await task
      } finally {
        if (inFlightOpens.get(id)?.task === task) inFlightOpens.delete(id)
      }
    },

    reopenWorkspaceRefreshed: async (id) => {
      // 重新登录成功后：先打开工作区（openView 可能复用会话失效前的缓存视图），
      // 再强制刷新——主进程注入最新会话 Cookie 并导航回工作区 URL，否则视图停在旧页面。
      await get().openWorkspace(id)
      // 仅在确实打开到该实例的工作区时刷新，避免打开失败（如实例未运行）后仍去刷新。
      if (get().selection === id && get().workspaceOpen) {
        await window.dshHub?.runtime.reloadView(id)
      }
    },

    openWorkspaceOrLogin: async (id) => {
      const name = get().instances.find((item) => item.id === id)?.name ?? id.slice(0, 8)
      // 远程实例运行后先探测认证：网关要求登录（await-credentials / needs-auth / await-otp）时
      // 先弹登录框引导登录，保留 loginGate，待登录成功（connected）由 App 的 auth 订阅打开工作区；
      // 其余相位（无网关 / 已连接 / 探测失败）直接打开工作区。
      const result = await window.dshHub?.auth.probe(id)
      const phase = result?.ok ? (result.value?.phase ?? null) : null
      const needsLogin =
        phase === 'needs-auth' || phase === 'await-credentials' || phase === 'await-otp'
      if (needsLogin) {
        window.dispatchEvent(new CustomEvent('dsh-hub:open-auth', { detail: { id, name } }))
        return
      }
      set((state) => ({ loginGate: state.loginGate.filter((item) => item !== id) }))
      void get().openWorkspace(id)
    },

    disconnectWorkspace: async (id) => {
      const generation = navigation.begin()
      disarmVisibility()
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
        // 不调 openView（端口尚未就绪）：只进加载页等 running 事件重触发。
        // 事件可能因状态陈旧永不抵达——超时兜底保证界面能退出加载页。
        const generation = navigation.begin()
        void window.dshHub?.runtime?.hideView()
        set(toOpeningPatch(id))
        armOpeningTimeout(id, generation)
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
          navigation.begin()
          disarmVisibility()
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
      set(toWizardClosedPatch(resumeId))
      if (!resumeId) return
      void window.dshHub?.runtime.openView(resumeId).then((result) => {
        if (
          result?.ok &&
          get().selection === resumeId &&
          !get().wizardOpen &&
          !get().settingsOpen
        ) {
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
        navigation.begin()
        disarmVisibility()
        void window.dshHub?.runtime?.hideView()
      }
      // 打开设置页即放弃当前选中,被遮挡工作区不再有可恢复的目标,挂起与待打开
      // 标记一并清除——否则实例启动完成会强制切回工作区、关掉设置页。
      set(toSettingsPatch(open))
      // 关闭设置页时选中已在打开时清空，记下 null 即「回总览」。
      writePersistedView(sessionStorage, {
        selection: open ? null : get().selection,
        settingsOpen: open
      })
    },

    /**
     * 启动时恢复上次视图（刷新渲染层用；应用重启时 sessionStorage 已空，仍是总览）。
     * 选中的实例已不存在（被删除）或记录取不回来时留在总览：宁可不恢复，也不进一个空详情页。
     */
    restoreView: async () => {
      const view = readPersistedView(sessionStorage)
      if (
        view.selection !== null &&
        get().instances.some((instance) => instance.id === view.selection)
      ) {
        // 先取回记录再切视图：否则详情页会先渲染一帧「找不到该实例」占位。
        const record = await get().ensureRecord(view.selection)
        if (record !== null) get().select(view.selection)
        return
      }
      if (view.selection === null && view.settingsOpen) get().setSettingsOpen(true)
    },

    /**
     * 主进程确认内容区边界已落到活动视图：解除可见性看守。
     * 由 App 在 updateViewBounds 返回 applied=true 时调用。
     */
    confirmWorkspaceVisible: (id) => {
      if (visibility !== null && visibility.id === id) disarmVisibility()
    },

    setPendingOpen: (id) => set((state) => ({ pendingOpen: [...state.pendingOpen, id] })),

    setLoginGate: (id) => set((state) => ({ loginGate: [...state.loginGate, id] }))
  }
}
