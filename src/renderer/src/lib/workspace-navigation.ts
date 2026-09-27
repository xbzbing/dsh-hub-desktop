/**
 * 工作区导航状态机（纯逻辑，不触碰 IPC / DOM）。
 *
 * 侧栏选中、打开/断开工作区、打开向导与设置页此前各自手工重复同一套「换视图」不变式：
 * 递增导航代（作废在途的过期 openView 响应）、隐藏原生视图、重置工作区标志位。
 * 本模块把这条不变式收敛为一处：
 * - `NavigationGuard` 持有导航代与「在途打开的实例」，`begin()` 递增并返回本次代号，
 *   `isCurrent(gen)` 判定是否仍是最新意图，`inFlight()` 给出正在打开的实例；
 * - 一组纯 patch 构造器给出每种导航目标下 store 应合入的状态片段。
 * IPC 副作用（hideView / openView）与 toast 仍留在 store 动作里，本模块只决定状态怎么变。
 */

/** 导航相关的 store 状态子集（patch 构造器的输入/输出形状）。 */
export interface WorkspaceNavState {
  /** 当前选中实例；null = 总览。 */
  selection: string | null
  /** 是否有主进程托管的内嵌工作区覆盖内容区。 */
  workspaceOpen: boolean
  /** 正在检测并打开工作区（加载中间页）。 */
  workspaceOpening: boolean
  /** 向导暂时遮挡了工作区，关闭后恢复。 */
  workspaceSuspended: boolean
  /** 设置页是否打开。 */
  settingsOpen: boolean
  /** 启动完成后待自动打开工作区的实例集合。 */
  pendingOpen: string[]
  /** 断开操作显式标记的工作区连接状态。 */
  workspaceConnected: Record<string, boolean>
}

/**
 * 导航代守卫：换视图前 `begin()` 递增，异步 openView 完成时用 `isCurrent(gen)`
 * 判断本次响应是否仍属于最新导航意图，过期响应只作废自己、绝不激活原生视图。
 * 同时持有「在途打开的实例」：`begin(id)` 记录，`inFlight()` 供状态事件判定
 * 「该实例的 openView 还没回来」，`clearInFlight(id)` 在完成时清除。
 */
export interface NavigationGuard {
  /** 换视图：递增导航代并返回本次代号；传 inFlightId 记录正在打开的实例。 */
  begin: (inFlightId?: string) => number
  /** 本次代号是否仍是最新导航意图。 */
  isCurrent: (generation: number) => boolean
  /** 正在等待 openView 返回的实例；无则 null。 */
  inFlight: () => string | null
  /** 清除在途标记；仅当仍是同一实例时清，避免覆盖后续导航记录的实例。 */
  clearInFlight: (id: string) => void
}

export function createNavigationGuard(): NavigationGuard {
  let generation = 0
  let inFlightId: string | null = null
  return {
    begin: (id) => {
      generation += 1
      if (id !== undefined) inFlightId = id
      return generation
    },
    isCurrent: (candidate) => candidate === generation,
    inFlight: () => inFlightId,
    clearInFlight: (id) => {
      if (inFlightId === id) inFlightId = null
    }
  }
}

/**
 * 进入某实例详情（侧栏选中 / 打开详情）。挂起标记与待打开标记一并清除：
 * 切走后不再等该实例启动完成，否则 running 事件会把界面强行拽回工作区。
 * `id=null` 即回到总览。
 */
export function toDetailPatch(id: string | null): Partial<WorkspaceNavState> {
  return {
    selection: id,
    workspaceOpen: false,
    workspaceOpening: false,
    workspaceSuspended: false,
    settingsOpen: false,
    pendingOpen: []
  }
}

/** 进入「正在打开工作区」的加载中间页。 */
export function toOpeningPatch(id: string): Partial<WorkspaceNavState> {
  return { selection: id, workspaceOpen: false, workspaceOpening: true, settingsOpen: false }
}

/** 工作区打开成功：显示内嵌视图并标记该实例已连接。 */
export function toOpenPatch(
  id: string,
  connected: Record<string, boolean>
): Partial<WorkspaceNavState> {
  return {
    workspaceOpen: true,
    workspaceOpening: false,
    workspaceConnected: { ...connected, [id]: true }
  }
}

/** 断开工作区：清工作区标志并标记该实例未连接（不停止运行时）。 */
export function toDisconnectedPatch(
  id: string,
  connected: Record<string, boolean>
): Partial<WorkspaceNavState> {
  return {
    workspaceOpen: false,
    workspaceOpening: false,
    workspaceConnected: { ...connected, [id]: false }
  }
}

/**
 * 打开设置页：放弃当前选中，被遮挡工作区不再有可恢复目标，挂起与待打开标记一并清除，
 * 否则实例启动完成会强制切回工作区、关掉设置页。关闭设置页只清 settingsOpen。
 */
export function toSettingsPatch(open: boolean): Partial<WorkspaceNavState> {
  return {
    settingsOpen: open,
    workspaceOpen: false,
    workspaceOpening: false,
    ...(open ? { selection: null, workspaceSuspended: false, pendingOpen: [] } : {})
  }
}

/** 向导遮挡工作区：先隐藏原生视图再挂载向导，标记为「已挂起、可恢复」。 */
export function suspendForWizardPatch(): Partial<WorkspaceNavState> {
  return { workspaceOpen: false, workspaceOpening: false, workspaceSuspended: true }
}

/**
 * 关闭向导：清 `wizardOpen`；若此前挂起过工作区（`resumeId` 非空）则一并清挂起标记，
 * 由调用方随后重开该实例的工作区。
 */
export function toWizardClosedPatch(resumeId: string | null): Partial<WorkspaceNavState> & {
  wizardOpen: false
} {
  return { wizardOpen: false, ...(resumeId !== null ? { workspaceSuspended: false } : {}) }
}
