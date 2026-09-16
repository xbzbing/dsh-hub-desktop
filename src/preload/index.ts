import { contextBridge, ipcRenderer } from 'electron'
import type { Settings } from '@shared/settings'
import { IPC, type AppInfo, type DshHubBridge, type PingResult } from '@shared/bridge'
import {
  AUTH_IPC,
  INSTANCE_IPC,
  INSTANCE_RUNTIME_IPC,
  HTTP_IPC,
  INSTANCE_STATUS_EVENT,
  SETTINGS_IPC,
  SSH_IPC,
  VAULT_IPC,
  type AskpassPromptPayload,
  type AuthSignalEvent,
  type AuthStateEvent,
  type AuthStateSnapshot,
  type HostKeyDecision,
  type HostKeyPromptPayload,
  type HttpAuthDetection,
  type InstanceStatusEvent,
  type IpcResult,
  type SshHostKeyForgetInput,
  type SshKeyPreviewInput,
  type SshKeyPreviewResult,
  type VaultPolicy,
  type VaultStatusSnapshot
} from '@shared/contracts'

/**
 * 白名单桥接：只暴露本文件内显式列出的方法，通道名一律走共享常量，
 * 避免主进程与渲染进程拼错字符串。
 */
const bridge: DshHubBridge = {
  getInfo: () => ipcRenderer.invoke(IPC.info) as Promise<IpcResult<AppInfo>>,
  ping: (message?: string) =>
    ipcRenderer.invoke(IPC.ping, message ?? null) as Promise<IpcResult<PingResult>>,
  instances: {
    list: () => ipcRenderer.invoke(INSTANCE_IPC.list),
    get: (id) => ipcRenderer.invoke(INSTANCE_IPC.get, id),
    create: (input) => ipcRenderer.invoke(INSTANCE_IPC.create, input),
    update: (id, patch) => ipcRenderer.invoke(INSTANCE_IPC.update, id, patch),
    remove: (id) => ipcRenderer.invoke(INSTANCE_IPC.delete, id)
  },
  runtime: {
    start: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.start, id),
    stop: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.stop, id),
    openView: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.openView, id),
    // 扫描不接收渲染层指定的目标；接管只接收 pid，主进程重新确认端口和 patch。
    scanExternal: () => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.scanExternal),
    adoptExternal: (id: string, pid: number) =>
      ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.adoptExternal, id, pid)
  },
  onInstanceStatus: (listener) => {
    // 只把载荷转给渲染层，不透传 IpcRendererEvent（其中含 sender 等能力对象）
    const handler = (_event: unknown, payload: InstanceStatusEvent): void => listener(payload)
    ipcRenderer.on(INSTANCE_STATUS_EVENT, handler)
    return () => {
      ipcRenderer.removeListener(INSTANCE_STATUS_EVENT, handler)
    }
  },
  ssh: {
    keyPreview: (input: SshKeyPreviewInput) =>
      ipcRenderer.invoke(SSH_IPC.keyPreview, input) as Promise<IpcResult<SshKeyPreviewResult>>,
    onHostKeyDecision: (listener) => {
      const handler = (_event: unknown, payload: HostKeyPromptPayload): void => listener(payload)
      ipcRenderer.on(SSH_IPC.hostKeyDecision, handler)
      return () => {
        ipcRenderer.removeListener(SSH_IPC.hostKeyDecision, handler)
      }
    },
    replyHostKey: (requestId: string, decision: HostKeyDecision) =>
      ipcRenderer.invoke(SSH_IPC.hostKeyReply, requestId, decision),
    // 显式恢复动作：删除本机保存的主机指纹，下次连接重新执行 TOFU。
    forgetHostKey: (input: SshHostKeyForgetInput) =>
      ipcRenderer.invoke(SSH_IPC.hostKeyForget, input) as Promise<IpcResult<null>>,
    onAskpassRequest: (listener) => {
      const handler = (_event: unknown, payload: AskpassPromptPayload): void => listener(payload)
      ipcRenderer.on(SSH_IPC.askpassRequest, handler)
      return () => {
        ipcRenderer.removeListener(SSH_IPC.askpassRequest, handler)
      }
    },
    replyAskpass: (requestId: string, secret: string | null) =>
      ipcRenderer.invoke(SSH_IPC.askpassReply, requestId, secret)
  },
  http: {
    detect: (endpointUrl: string) =>
      ipcRenderer.invoke(HTTP_IPC.detect, endpointUrl) as Promise<IpcResult<HttpAuthDetection>>
  },
  auth: {
    probe: (instanceId: string) =>
      ipcRenderer.invoke(AUTH_IPC.probe, instanceId) as Promise<IpcResult<AuthStateSnapshot | null>>,
    login: (instanceId: string, password: string, otp?: string) =>
      ipcRenderer.invoke(AUTH_IPC.login, instanceId, password, otp ?? null) as Promise<
        IpcResult<AuthStateSnapshot | null>
      >,
    // 密码不跨 IPC；只传实例 ID 和可选 OTP，由主进程读取已保存的密码。
    loginStored: (instanceId: string, otp?: string) =>
      ipcRenderer.invoke(AUTH_IPC.loginStored, instanceId, otp ?? null) as Promise<
        IpcResult<AuthStateSnapshot | null>
      >,
    logout: (instanceId: string) =>
      ipcRenderer.invoke(AUTH_IPC.logout, instanceId) as Promise<IpcResult<AuthStateSnapshot | null>>,
    onState: (listener) => {
      const handler = (_event: unknown, payload: AuthStateEvent): void => listener(payload)
      ipcRenderer.on(AUTH_IPC.state, handler)
      return () => {
        ipcRenderer.removeListener(AUTH_IPC.state, handler)
      }
    },
    onSignal: (listener) => {
      const handler = (_event: unknown, payload: AuthSignalEvent): void => listener(payload)
      ipcRenderer.on(AUTH_IPC.signal, handler)
      return () => {
        ipcRenderer.removeListener(AUTH_IPC.signal, handler)
      }
    }
  },
  // 非敏感应用偏好：语言、主题、托盘、自启和通知。
  settings: {
    get: () => ipcRenderer.invoke(SETTINGS_IPC.get) as Promise<IpcResult<Settings>>,
    update: (patch) =>
      ipcRenderer.invoke(SETTINGS_IPC.update, patch) as Promise<IpcResult<Settings>>,
    // 打开数据目录:白名单里**不带任何参数**(路径由主进程解析),渲染层传不了路径
    openDataDir: () => ipcRenderer.invoke(SETTINGS_IPC.openDataDir) as Promise<IpcResult<null>>
  },
  // 只暴露状态和管理操作，不提供读取凭据的通道；凭据仅在主进程内使用。
  vault: {
    status: () =>
      ipcRenderer.invoke(VAULT_IPC.status) as Promise<IpcResult<VaultStatusSnapshot>>,
    setPolicy: (instanceId, policy) =>
      ipcRenderer.invoke(VAULT_IPC.setPolicy, instanceId, policy) as Promise<
        IpcResult<VaultPolicy>
      >,
    forget: (instanceId, target) =>
      ipcRenderer.invoke(VAULT_IPC.forget, instanceId, target ?? null) as Promise<
        IpcResult<VaultPolicy>
      >,
    clear: () =>
      ipcRenderer.invoke(VAULT_IPC.clear) as Promise<IpcResult<VaultStatusSnapshot>>
  }
}

contextBridge.exposeInMainWorld('dshHub', bridge)