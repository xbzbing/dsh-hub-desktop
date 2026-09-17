/**
 * 渲染进程 ↔ 主进程桥接面（白名单）。
 *
 * 框架无关：不 import electron，主进程 / 预加载 / 渲染进程共享同一份类型与通道名，
 * 符合全局规则 5（registry / transport / auth / shared 不依赖 electron）。
 *
 * 实例注册表相关类型与通道常量见 `./contracts.ts`；本文件只承载桥接面本身。
 */

import type { Settings } from './settings'
import type {
  AskpassPromptPayload,
  AuthSignalEvent,
  AuthStateEvent,
  AuthStateSnapshot,
  CreateInstanceInput,
  ExternalDshWebSnapshot,
  HostKeyDecision,
  HostKeyPromptPayload,
  HttpAuthDetection,
  InstanceRecord,
  InstanceStatusEvent,
  InstanceSummary,
  LocalDshSnapshot,
  VaultPolicy,
  VaultStatusSnapshot,
  IpcResult,
  PatchInstanceInput,
  SshHostKeyForgetInput,
  SshKeyPreviewInput,
  SshKeyPreviewResult,
  WorkspaceViewBounds
} from './contracts'

export const IPC = {
  /** 返回应用信息（版本 / 平台 / 数据目录），同时充当主进程存活探针 */
  info: 'app:info',
  /** 空回显，用于验证双向 IPC 通路连通 */
  ping: 'app:ping'
} as const

export interface AppInfo {
  /** package.json 版本（app.getVersion()） */
  appVersion: string
  platform: string
  arch: string
  /** 渲染引擎版本（Electron 内嵌 Chromium） */
  chrome: string
  electron: string
  node: string
  /** 应用数据根目录：实例注册表 / 审计日志 / 隔离的 DSH_HOME 都在其下 */
  userDataPath: string
}

export interface PingResult {
  /** 主进程原样回显；未传参时为 null */
  echo: string | null
  /** 主进程响应时间戳（epoch ms） */
  at: number
}

export interface DshHubBridge {
  /** 主进程返回的应用信息快照 */
  getInfo: () => Promise<IpcResult<AppInfo>>
  /** 双向 IPC 探针 */
  ping: (message?: string) => Promise<IpcResult<PingResult>>
  /** 实例注册表 CRUD；通道常量与字段模型见 contracts.ts。 */
  instances: {
    list: () => Promise<IpcResult<InstanceSummary[]>>
    get: (id: string) => Promise<IpcResult<InstanceRecord | null>>
    create: (input: CreateInstanceInput) => Promise<IpcResult<InstanceRecord>>
    update: (id: string, patch: PatchInstanceInput) => Promise<IpcResult<InstanceRecord>>
    remove: (id: string) => Promise<IpcResult<{ removed: boolean }>>
  }
  /** 本地实例运行时控制：start/stop 立即返回，进展经 onInstanceStatus 回推。 */
  runtime: {
    start: (id: string) => Promise<IpcResult<null>>
    stop: (id: string) => Promise<IpcResult<null>>
    openView: (id: string) => Promise<IpcResult<null>>
    updateViewBounds: (bounds: WorkspaceViewBounds) => Promise<IpcResult<null>>
    hideView: () => Promise<IpcResult<null>>
    probeLocalDsh: () => Promise<IpcResult<LocalDshSnapshot | null>>
    /**
     * 列出本机已运行的 dsh web 进程。无参数；返回项包含 pid、监听端口和 `--patch` 路径。
     */
    scanExternal: () => Promise<IpcResult<ExternalDshWebSnapshot[]>>
    /**
     * 接管检测到的外部 dsh web。`access` 是用户提供的 token 或完整 URL，只在主进程会话内保留。
     */
    adoptExternal: (id: string, pid: number, access: string) => Promise<IpcResult<null>>
  }
  /** 订阅实例状态事件；返回取消订阅函数（渲染层不接触原始 IPC 事件对象） */
  onInstanceStatus: (listener: (event: InstanceStatusEvent) => void) => () => void
  /** SSH 传输辅助：密钥预览、主机指纹确认和口令输入。 */
  ssh: {
    /** 只读密钥预览（ssh -G + ssh-add -L）；不含私钥内容 */
    keyPreview: (input: SshKeyPreviewInput) => Promise<IpcResult<SshKeyPreviewResult>>
    /** 订阅指纹确认请求（TOFU；首次/变化双变体） */
    onHostKeyDecision: (listener: (payload: HostKeyPromptPayload) => void) => () => void
    /** 回复指纹确认；decision=trust 才会写入 hub 私有 known_hosts */
    replyHostKey: (requestId: string, decision: HostKeyDecision) => Promise<IpcResult<null>>
    /**
     * 忘记该实例主机的已信任公钥；这是显式且破坏性的恢复操作。
     * 不属于连接确认流程：连接时指纹变化一律拒绝且不改动旧公钥；只有走完本动作后，
     * 下一次连接才会重新走首次 TOFU 确认。
     */
    forgetHostKey: (input: SshHostKeyForgetInput) => Promise<IpcResult<null>>
    /** 订阅口令输入请求（ssh 索要私钥口令/密码）；口令不落盘 */
    onAskpassRequest: (listener: (payload: AskpassPromptPayload) => void) => () => void
    /** 回复口令；secret=null 表示取消 */
    replyAskpass: (requestId: string, secret: string | null) => Promise<IpcResult<null>>
  }
  /** HTTP 直连辅助：端点认证模式只读探测。 */
  http: {
    /** 对草稿 URL 做只读探测；非法 URL 返回 invalid-input 信封。 */
    detect: (endpointUrl: string) => Promise<IpcResult<HttpAuthDetection>>
  }
  /** 认证状态流和登录提交；凭据只在主进程内存中流转。 */
  auth: {
    probe: (instanceId: string) => Promise<IpcResult<AuthStateSnapshot | null>>
    /** 提交密码（可同时带 OTP 完成单请求 2FA） */
    login: (instanceId: string, password: string, otp?: string) => Promise<IpcResult<AuthStateSnapshot | null>>
    /**
     * 使用保险库中保存的密码登录。**密码不跨 IPC**——
     * 主进程自行从 vault 读取；渲染层只传可选 OTP。未勾选「记住密码」或无已存
     * 密码时返回 invalid-input。
     */
    loginStored: (instanceId: string, otp?: string) => Promise<IpcResult<AuthStateSnapshot | null>>
    logout: (instanceId: string) => Promise<IpcResult<AuthStateSnapshot | null>>
    /** 订阅状态变化；返回取消订阅函数 */
    onState: (listener: (event: AuthStateEvent) => void) => () => void
    /** 订阅 webview 拦截信号（会话失效/需要验证码/需要改密） */
    onSignal: (listener: (event: AuthSignalEvent) => void) => () => void
  }
  /** 应用设置（非敏感偏好：语言、主题、托盘、自启和通知）。 */
  settings: {
    get: () => Promise<IpcResult<Settings>>
    update: (patch: Partial<Settings>) => Promise<IpcResult<Settings>>
    /**
     * 打开应用数据目录。
     * **没有参数**:目录由主进程自行解析,渲染层无法指定路径。
     */
    openDataDir: () => Promise<IpcResult<null>>
  }
  /** 凭据保险库：默认不保存，显式勾选后才落盘。 */
  vault: {
    status: () => Promise<IpcResult<VaultStatusSnapshot>>
    setPolicy: (instanceId: string, policy: VaultPolicy) => Promise<IpcResult<VaultPolicy>>
    /** 忘掉某实例已记住的凭据(可只忘密码/只忘会话) */
    forget: (
      instanceId: string,
      target?: { password?: boolean; session?: boolean }
    ) => Promise<IpcResult<VaultPolicy>>
    /** 一键清空全部已记住凭据 */
    clear: () => Promise<IpcResult<VaultStatusSnapshot>>
  }
}