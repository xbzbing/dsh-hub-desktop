/**
 * 渲染进程 ↔ 主进程桥接面（白名单）。
 *
 * 框架无关：不 import electron，主进程 / 预加载 / 渲染进程共享同一份类型与通道名，
 * 符合全局规则 5（registry / transport / auth / shared 不依赖 electron）。
 *
 * 实例注册表相关类型与通道常量见 `./contracts.ts`（T2 起）；本文件只承载桥接面本身。
 */

import type {
  AskpassPromptPayload,
  AuthSignalEvent,
  AuthStateEvent,
  AuthStateSnapshot,
  CreateInstanceInput,
  HostKeyDecision,
  HostKeyPromptPayload,
  HttpAuthDetection,
  InstanceRecord,
  InstanceStatusEvent,
  InstanceSummary,
  IpcResult,
  PatchInstanceInput,
  SshKeyPreviewInput,
  SshKeyPreviewResult
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
  /** 实例注册表 CRUD（T2；通道常量与字段模型见 contracts.ts） */
  instances: {
    list: () => Promise<IpcResult<InstanceSummary[]>>
    get: (id: string) => Promise<IpcResult<InstanceRecord | null>>
    create: (input: CreateInstanceInput) => Promise<IpcResult<InstanceRecord>>
    update: (id: string, patch: PatchInstanceInput) => Promise<IpcResult<InstanceRecord>>
    remove: (id: string) => Promise<IpcResult<{ removed: boolean }>>
  }
  /** 本地实例运行时控制（T3）：start/stop 立即返回，进展经 onInstanceStatus 回推 */
  runtime: {
    start: (id: string) => Promise<IpcResult<null>>
    stop: (id: string) => Promise<IpcResult<null>>
    openView: (id: string) => Promise<IpcResult<null>>
  }
  /** 订阅实例状态事件；返回取消订阅函数（渲染层不接触原始 IPC 事件对象） */
  onInstanceStatus: (listener: (event: InstanceStatusEvent) => void) => () => void
  /** SSH 传输辅助（T5）：密钥预览 / 主机指纹确认 / 口令输入 */
  ssh: {
    /** 只读密钥预览（ssh -G + ssh-add -L）；不含私钥内容 */
    keyPreview: (input: SshKeyPreviewInput) => Promise<IpcResult<SshKeyPreviewResult>>
    /** 订阅指纹确认请求（TOFU；首次/变化双变体） */
    onHostKeyDecision: (listener: (payload: HostKeyPromptPayload) => void) => () => void
    /** 回复指纹确认；decision=trust 才会写入 hub 私有 known_hosts */
    replyHostKey: (requestId: string, decision: HostKeyDecision) => Promise<IpcResult<null>>
    /** 订阅口令输入请求（ssh 索要私钥口令/密码）；口令不落盘 */
    onAskpassRequest: (listener: (payload: AskpassPromptPayload) => void) => () => void
    /** 回复口令；secret=null 表示取消 */
    replyAskpass: (requestId: string, secret: string | null) => Promise<IpcResult<null>>
  }
  /** HTTP 直连辅助（T6）：端点认证模式只读探测（向导 urlDetect） */
  http: {
    /** 对草稿 URL 做 §2.3 探测；非法 URL 返回 invalid-input 信封 */
    detect: (endpointUrl: string) => Promise<IpcResult<HttpAuthDetection>>
  }
  /** 认证（T8）：状态流 + 登录提交（凭据只在主进程内存中流转） */
  auth: {
    probe: (instanceId: string) => Promise<IpcResult<AuthStateSnapshot | null>>
    /** 提交密码（可同时带 OTP 完成单请求 2FA） */
    login: (instanceId: string, password: string, otp?: string) => Promise<IpcResult<AuthStateSnapshot | null>>
    logout: (instanceId: string) => Promise<IpcResult<AuthStateSnapshot | null>>
    /** 订阅状态变化；返回取消订阅函数 */
    onState: (listener: (event: AuthStateEvent) => void) => () => void
    /** 订阅 webview 拦截信号（会话失效/需要验证码/需要改密） */
    onSignal: (listener: (event: AuthSignalEvent) => void) => () => void
  }
}