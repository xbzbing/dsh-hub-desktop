import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { createVault } from './vault/vault'
import type { Vault } from './vault/vault'

export interface VaultControl {
  /** 凭据保险库（凭据与会话的落盘入口） */
  vault: Vault
  /** safeStorage 是否可用；false 时保险库降级 */
  safeStorageAvailable: boolean
  /** 当前 safeStorage 后端枚举（尚未初始化时为 undefined） */
  safeStorageBackend: () => string | undefined
}

/**
 * safeStorage 装配与凭据保险库初始化。
 */
export function createVaultControl(dataRoot: string): VaultControl {
  const safeStorageAvailable = (() => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  })()
  if (!app.isPackaged && process.env.DSH_HUB_E2E_PASSWORD_STORE) {
    // E2E 显式指定了 safeStorage 后端:打印开关是否送达与最终选中的后端,
    // 否则 CI 上「开关已传但保险库仍降级」无法区分是注入丢失还是后端初始化失败;
    // 打包产物(app.isPackaged)不输出该诊断
    console.error(
      '[main] safeStorage 诊断：',
      JSON.stringify({
        switch: app.commandLine.hasSwitch('password-store'),
        value: app.commandLine.getSwitchValue('password-store'),
        available: safeStorageAvailable,
        backend: safeStorage.getSelectedStorageBackend?.() ?? null,
        dbus: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS)
      })
    )
  }
  const vault = createVault({
    filePath: join(dataRoot, 'vault', 'credentials.json'),
    crypto: {
      isAvailable: () => safeStorageAvailable,
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, 'base64'))
    }
  })
  return {
    vault,
    safeStorageAvailable,
    safeStorageBackend: () => safeStorage.getSelectedStorageBackend?.() ?? undefined
  }
}
