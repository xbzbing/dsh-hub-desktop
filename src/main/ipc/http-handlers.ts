import { ipcMain } from 'electron'
import { z } from 'zod'
import { HTTP_IPC, type HttpAuthDetection, type IpcResult } from '@shared/contracts'
import { detectDraftEndpoint } from '../transport/http-endpoint'

export function registerHttpHandlers(
  wrap: <T>(task: () => Promise<T> | T) => Promise<IpcResult<T>>
): void {
  ipcMain.handle(
    HTTP_IPC.detect,
    (_event, endpointUrl: unknown): Promise<IpcResult<HttpAuthDetection>> =>
      wrap(() => {
        const raw = z.string().trim().min(1).max(2048).parse(endpointUrl)
        return detectDraftEndpoint(raw)
      })
  )
}
