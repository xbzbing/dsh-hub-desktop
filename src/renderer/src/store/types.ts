/** store 分片共享的类型：对外形状（AppState）与各分片切面。 */
import type {
  AuthPhase,
  DshVersionProgressEvent,
  InstanceRecord,
  InstanceStatusEvent,
  InstanceSummary,
  VaultStatusSnapshot
} from '@shared/contracts'
import type { Language, Settings } from '@shared/settings'
import type { Translator } from '@shared/i18n'

export interface ToastItem {
  id: number
  kind: 'ok' | 'info' | 'warn' | 'err'
  title: string
  detail?: string
}

export type ToastKind = ToastItem['kind']

/**
 * 实例活动日志行：运行状态事件的 detail 原文，或一次版本升级进度事件。
 * 详情页底部信息栏按时间顺序展示，标题区不再承载原始日志。
 * `seq` 是追加时分配的单调递增序号，作为 React key —— 截尾到 200 行后按 index 做 key
 * 会整体左移导致每次追加全量重挂，用不随截尾变化的 seq 才能稳定复用 DOM 节点。
 */
export type ActivityInput =
  | { source: 'runtime'; at: string; detail: string }
  | { source: 'version'; event: DshVersionProgressEvent }

export type ActivityLine = ActivityInput & { seq: number }

/** 偏好 / 主题 / i18n。 */
export interface SettingsSlice {
  rail: boolean
  theme: 'light' | 'dark'
  /** 非敏感偏好，由主进程 settings.json 保存。 */
  settings: Settings
  /** 实际生效的语言(偏好 + 系统语言推断后的结果) */
  language: Language
  /** 当前语言的翻译函数(组件统一从这里取文案) */
  t: Translator
  /** 主进程提供的系统区域设置；hydrate 前用 navigator.language 兜底 */
  systemLocale: string
  toggleRail: () => void
  toggleTheme: () => void
  /** 订阅系统主题变化，仅在 theme='system' 时生效。 */
  subscribeSystemTheme: () => () => void
  /** 从主进程读取并应用偏好。 */
  hydrateSettings: () => Promise<void>
  /** 更新并立即应用偏好。 */
  updateSettings: (patch: Partial<Settings>) => Promise<void>
}

/** 一次性提示条。 */
export interface ToastSlice {
  toasts: ToastItem[]
  toast: (kind: ToastKind, title: string, detail?: string) => void
  dismissToast: (id: number) => void
}

/** 凭据保险库快照。 */
export interface VaultSlice {
  /**
   * 凭据保险库快照。登录成功时主进程会**静默**写入凭据，渲染层不会收到任何事件，
   * 因此必须由登录流程显式刷新，否则详情页的「凭据存储」会一直停留在旧状态。
   */
  vaultStatus: VaultStatusSnapshot | null
  setVaultStatus: (status: VaultStatusSnapshot) => void
  refreshVault: () => Promise<void>
}

/** 实例列表、详情缓存、运行状态、认证相位与活动日志。 */
export interface InstanceSlice {
  /** 首次列表是否已加载；加载时显示骨架屏。 */
  loaded: boolean
  /** 最近一次实例列表加载失败的原因；null 表示加载成功 */
  listError: string | null
  instances: InstanceSummary[]
  /** 详情缓存:进入详情页时按需 get */
  records: Record<string, InstanceRecord>
  /** 运行时状态事件(id → 最新事件) */
  statuses: Record<string, InstanceStatusEvent>
  /** 主进程 userData 路径(app:info 快照;详情页展示实例数据目录用) */
  userDataPath: string | null
  /** dsh 公共空间（默认 DSH_HOME）在本机的绝对路径（app:info 快照；向导展示用） */
  defaultDshHome: string | null
  /**
   * 各实例的认证相位快照，用于控制详情页认证操作的可见性。
   * 未收到事件的实例不在 map 中。
   */
  authPhases: Record<string, AuthPhase>
  /**
   * 实例活动日志（运行状态 detail + 版本升级进度），详情页底部信息栏展示。
   * 每实例保留最近 200 行；未产生过活动的实例不在 map 中。
   */
  activityLog: Record<string, ActivityLine[]>
  /**
   * 已提示过「自动禁用不兼容插件」的实例（instanceId → 判定的 dsh 版本），仅本会话有效。
   * 标记放在 store 而非插件卡组件里：并发加载与组件重挂载（切换实例、record 短暂缺失）
   * 都不该让同一次自动禁用重复弹提示。
   */
  autoDisabledNotified: Record<string, string>
  load: () => Promise<void>
  refreshList: () => Promise<void>
  /** 按给定 ID 列表重排实例顺序（乐观更新 + IPC 持久化）。 */
  reorderInstances: (orderedIds: string[]) => Promise<void>
  applyStatus: (event: InstanceStatusEvent) => void
  ensureRecord: (id: string) => Promise<InstanceRecord | null>
  /** 强制从主进程重读该实例(绕过缓存)—— 编辑保存后刷新详情必须用它:
      `ensureRecord` 只在缓存缺失时拉取,会把陈旧记录留在 store 里 */
  reloadRecord: (id: string) => Promise<void>
  /** 删除实例并提示成败；返回是否成功，由调用方清理自身状态并刷新列表。 */
  removeInstance: (input: { id: string; name: string; trashSpace: boolean }) => Promise<boolean>
  /** 写入/清除实例的认证相位(登出后为最新相位,无需特判) */
  applyAuthPhase: (instanceId: string, phase: AuthPhase) => void
  /** 追加一行活动日志；连续重复行去重，超限丢弃最旧。 */
  appendActivity: (instanceId: string, line: ActivityInput) => void
  /** 清空某实例的活动日志。 */
  clearActivity: (instanceId: string) => void
  /**
   * 领取「已自动禁用不兼容插件」提示的发送权：该实例在该 dsh 版本上首次调用返回 true，
   * 其后返回 false。同步判定，因此并发的插件列表加载不会各自通过。
   */
  notifyAutoDisabledOnce: (instanceId: string, dshVersion: string) => boolean
}

/** 工作区导航、选中、向导与设置页开合。 */
export interface WorkspaceSlice {
  /** 当前选中(侧边栏),null = 回到总览 */
  selection: string | null
  /** 当前是否有主进程托管的内嵌工作区覆盖内容区。 */
  workspaceOpen: boolean
  /** 正在检测并打开实例工作区；完成前保持加载中间页而不是切换详情。 */
  workspaceOpening: boolean
  /**
   * 向导暂时遮挡了主进程工作区；关闭向导后恢复已缓存视图。
   * 「关于」由独立叠加窗口承载，不参与遮挡与恢复。
   */
  workspaceSuspended: boolean
  /** 断开操作显式标记的工作区；未标记实例沿用运行时状态展示。 */
  workspaceConnected: Record<string, boolean>
  wizardOpen: boolean
  /** 设置页选择的已有隔离空间；打开向导后仅用于本次创建。 */
  wizardExistingSpaceId: string | null
  /** 设置页是否打开；打开时不显示实例详情。 */
  settingsOpen: boolean
  /** 向导创建后待自动打开的实例集合(多个实例并发启动时各自独立) */
  pendingOpen: string[]
  /**
   * 向导创建后待「先登录再打开工作区」的远程实例集合：这些实例运行后先探测认证，
   * 若网关要求登录则弹出登录框而非直接打开工作区，登录成功（connected）后再打开。
   */
  loginGate: string[]
  setWorkspaceOpen: (open: boolean) => void
  select: (id: string | null) => void
  /** 取回记录并选中；列表页与设置页跳转详情共用。 */
  openDetail: (id: string) => void
  /** 选择实例后打开其工作区；失败时保留详情，提示用户原因。 */
  openWorkspace: (id: string) => Promise<void>
  /**
   * 重新登录成功后重新打开工作区并刷新：先打开（可能复用缓存视图），再强制注入最新
   * 会话 Cookie 并导航回工作区 URL，确保显示已登录页面而非会话失效前的旧页面。
   */
  reopenWorkspaceRefreshed: (id: string) => Promise<void>
  /** 断开指定实例的内嵌工作区，不停止其运行时。 */
  disconnectWorkspace: (id: string) => Promise<void>
  /** 侧栏入口：处于错误状态的本机实例直接展示详情，避免必然失败的启动尝试。 */
  openFromSidebar: (id: string) => void
  setWizardOpen: (open: boolean) => void
  /** 打开向导并指定一个由主进程验证过的隔离空间。 */
  createWithExistingSpace: (id: string) => void
  setSettingsOpen: (open: boolean) => void
  /**
   * 启动时恢复上次视图（详情页选中的实例或设置页）；仅在刷新渲染层时有意义。
   * 选中的实例已不存在时留在总览。
   */
  restoreView: () => Promise<void>
  setPendingOpen: (id: string) => void
  /** 登记一个远程实例：运行后先探测认证，网关需登录则先弹登录框，登录成功后再打开工作区。 */
  setLoginGate: (id: string) => void
  /**
   * 远程实例运行后的「先登录再打开」判定：探测认证相位，需登录则弹登录框并保留 loginGate
   * （待 connected 后由 App 的 auth:state 订阅打开工作区）；否则清除标记并直接打开工作区。
   */
  openWorkspaceOrLogin: (id: string) => Promise<void>
}

/** 组合后的完整 store 形状。 */
export type AppState = SettingsSlice & ToastSlice & VaultSlice & InstanceSlice & WorkspaceSlice

/** 分片的 zustand StateCreator 签名（共享同一 set/get，切面之间可互相调用）。 */
export type SliceCreator<T> = (
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState
) => T
