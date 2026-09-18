import { ipcMain } from 'electron'
import { z } from 'zod'
import { SETTINGS_IPC, type IpcResult } from '@shared/contracts'
import { SettingsSchema, type Settings } from '@shared/settings'
import type { SettingsStore } from '../settings/settings-store'
import { DataDirOpenError } from '../shell/open-data-dir'

export interface SettingsHandlerDeps {
  settings: SettingsStore
  onSettingsChanged?: (settings: Settings, changedKeys: readonly (keyof Settings)[]) => void
  openDataDir?: () => Promise<void>
}

export function registerSettingsHandlers(
  deps: SettingsHandlerDeps,
  wrap: <T>(task: () => Promise<T> | T) => Promise<IpcResult<T>>
): void {
  ipcMain.handle(
    SETTINGS_IPC.get,
    (): Promise<IpcResult<Settings>> => wrap(() => deps.settings.read())
  )

  ipcMain.handle(
    SETTINGS_IPC.update,
    (_event, patch: unknown): Promise<IpcResult<Settings>> =>
      wrap(async () => {
        const raw = z.record(z.string(), z.unknown()).parse(patch)
        SettingsSchema.partial().strict().parse(raw)
        const known = Object.keys(SettingsSchema.shape) as Array<keyof Settings>
        const provided: Partial<Settings> = {}
        for (const key of known) {
          if (key in raw) provided[key] = raw[key] as never
        }
        const next = await deps.settings.update(provided)
        deps.onSettingsChanged?.(next, Object.keys(provided) as Array<keyof Settings>)
        return next
      })
  )

  ipcMain.handle(
    SETTINGS_IPC.openDataDir,
    (_event, ...args: unknown[]): Promise<IpcResult<null>> =>
      wrap(async () => {
        z.tuple([]).parse(args)
        if (!deps.openDataDir) throw new DataDirOpenError('internal', '打开数据目录不可用')
        await deps.openDataDir()
        return null
      })
  )
}
