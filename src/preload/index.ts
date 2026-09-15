import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppInfo, type DshHubBridge, type PingResult } from '@shared/bridge'
import {
  INSTANCE_IPC,
  INSTANCE_RUNTIME_IPC,
  HTTP_IPC,
  INSTANCE_STATUS_EVENT,
  SSH_IPC,
  type AskpassPromptPayload,
  type HostKeyDecision,
  type HostKeyPromptPayload,
  type HttpAuthDetection,
  type InstanceStatusEvent,
  type IpcResult,
  type SshKeyPreviewInput,
  type SshKeyPreviewResult
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
    openView: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.openView, id)
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
  }
}

contextBridge.exposeInMainWorld('dshHub', bridge)