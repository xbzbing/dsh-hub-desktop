/** 凭据保险库快照分片。 */
import type { SliceCreator, VaultSlice } from './types'

export const createVaultSlice: SliceCreator<VaultSlice> = (set) => ({
  vaultStatus: null,

  setVaultStatus: (status) => set({ vaultStatus: status }),

  refreshVault: async () => {
    const result = await window.dshHub?.vault.status()
    // 读取失败时保留上一份快照:把「已记住」翻回「未记住」是误导,且会诱使用户重复保存。
    if (result?.ok) set({ vaultStatus: result.value })
  }
})
