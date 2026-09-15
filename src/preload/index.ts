import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppInfo, type DshHubBridge, type PingResult } from '@shared/bridge'

/**
 * 白名单桥接：只暴露本文件内显式列出的方法，通道名一律走共享常量，
 * 避免主进程与渲染进程拼错字符串。
 */
const bridge: DshHubBridge = {
  getInfo: () => ipcRenderer.invoke(IPC.info) as Promise<AppInfo>,
  ping: (message?: string) =>
    ipcRenderer.invoke(IPC.ping, message ?? null) as Promise<PingResult>
}

contextBridge.exposeInMainWorld('dshHub', bridge)