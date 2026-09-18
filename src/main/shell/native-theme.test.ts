import { describe, expect, it } from 'vitest'
import { applyNativeThemeSource } from './native-theme'

describe('applyNativeThemeSource', () => {
  it('将 Hub 的显式深色主题同步为 Electron 原生深色源', () => {
    const port = { themeSource: 'system' as const }

    applyNativeThemeSource('dark', port)

    expect(port.themeSource).toBe('dark')
  })

  it('Hub 跟随系统时恢复 Electron 系统主题源', () => {
    const port = { themeSource: 'dark' as const }

    applyNativeThemeSource('system', port)

    expect(port.themeSource).toBe('system')
  })
})
