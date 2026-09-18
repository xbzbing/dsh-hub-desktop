import { app, ipcMain } from 'electron'
import { IPC, type AppInfo, type PingResult } from '@shared/bridge'
import type { IpcResult } from '@shared/contracts'

export function registerAppHandlers(
  processVersions: NodeJS.ProcessVersions & { electron?: string },
  wrap: <T>(task: () => Promise<T> | T) => Promise<IpcResult<T>>
): void {
  ipcMain.handle(IPC.info, (): Promise<IpcResult<AppInfo>> =>
    wrap(() => ({
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      chrome: process.versions.chrome,
      electron: processVersions.electron ?? '',
      node: process.versions.node,
      userDataPath: app.getPath('userData')
    }))
  )

  ipcMain.handle(IPC.ping, (_event, message: unknown): Promise<IpcResult<PingResult>> =>
    wrap(() => ({
      echo: typeof message === 'string' && message !== '' ? message : null,
      at: Date.now()
    }))
  )
}
