import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppInfo, type DshHubBridge, type PingResult } from '@shared/bridge'
import {
  INSTANCE_IPC,
  INSTANCE_RUNTIME_IPC,
  INSTANCE_STATUS_EVENT,
  type InstanceStatusEvent,
  type IpcResult
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
  }
}

contextBridge.exposeInMainWorld('dshHub', bridge)