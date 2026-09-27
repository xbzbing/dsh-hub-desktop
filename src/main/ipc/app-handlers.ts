import { app, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC, type AppInfo, type PingResult } from '@shared/bridge'
import type { IpcResult } from '@shared/contracts'
import { systemLocale } from '../system-locale'

/** ping 入参：字符串或省略/null；与其余通道一致在边界走 zod 校验。 */
const PingMessageSchema = z.string().max(4096).nullish()

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
      v8: process.versions.v8,
      userDataPath: app.getPath('userData'),
      locale: systemLocale()
    }))
  )

  ipcMain.handle(IPC.ping, (_event, message: unknown): Promise<IpcResult<PingResult>> =>
    wrap(() => {
      const parsed = PingMessageSchema.parse(message)
      return {
        echo: parsed !== null && parsed !== undefined && parsed !== '' ? parsed : null,
        at: Date.now()
      }
    })
  )
}
