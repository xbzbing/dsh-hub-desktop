import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/settings'

/**
 * store.ts 的测试（T11 复审遗留）。
 *
 * 复审指出仓库**没有任何 store 测试**，而 `store.ts` 在模块作用域就访问
 * `localStorage`/`window.matchMedia`/`navigator`/`window.dshHub`，
 * 且 vitest 跑在 `environment: 'node'` 下 —— 于是「切换语言后翻译器不刷新」
 * 「hydrateSettings 不应用语言」这类缺陷在测试全绿时存活。
 * 这里先桩好浏览器全局对象，再**动态导入** store（模块作用域求值前完成打桩）。
 */

const DEFAULTS: Settings = {
  language: 'zh',
  theme: 'system',
  tray: false,
  autoStart: false,
  notifications: true
}

type SettingsResult = { ok: true; value: Settings } | { ok: false; message: string }

let settingsValue: Settings
let updateResult: SettingsResult | null
let updateCalls: Array<Partial<Settings>>
let updateImpl: ((patch: Partial<Settings>) => SettingsResult | Promise<SettingsResult>) | null
let themeListeners: Array<() => void>
let matchDark: boolean
let storedTheme: string | null

function installGlobals(): void {
  settingsValue = { ...DEFAULTS }
  updateResult = null
  updateCalls = []
  updateImpl = null
  themeListeners = []
  matchDark = false
  storedTheme = null

  const media = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => {
      themeListeners.push(listener)
    },
    removeEventListener: (_: string, listener: () => void) => {
      themeListeners = themeListeners.filter((entry) => entry !== listener)
    }
  }
  Object.defineProperty(media, 'matches', { get: () => matchDark })

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'dshhub-theme' ? storedTheme : null),
    setItem: (key: string, value: string) => {
      if (key === 'dshhub-theme') storedTheme = value
    }
  })
  vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string> } })
  vi.stubGlobal('navigator', { language: 'zh-CN' })
  vi.stubGlobal('window', {
    matchMedia: () => media,
    dshHub: {
      settings: {
        get: async () => ({ ok: true, value: settingsValue }),
        update: async (patch: Partial<Settings>) => {
          updateCalls.push(patch)
          if (updateImpl) return await updateImpl(patch)
          if (updateResult) return updateResult
          settingsValue = { ...settingsValue, ...patch }
          return { ok: true, value: settingsValue }
        }
      },
      getInfo: async () => ({ ok: false }),
      instances: { list: async () => ({ ok: true, value: [] }) }
    }
  })
}

async function freshStore(): Promise<typeof import('./store').useAppStore> {
  vi.resetModules()
  installGlobals()
  const module = await import('./store')
  return module.useAppStore
}

describe('store 设置切片（T11 复审遗留：此前无任何 store 测试）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrateSettings 应用偏好语言并刷新翻译器(变异 M8)', async () => {
    const useAppStore = await freshStore()
    settingsValue = { ...DEFAULTS, language: 'en' }
    await useAppStore.getState().hydrateSettings()
    const state = useAppStore.getState()
    expect(state.settings.language).toBe('en')
    expect(state.language).toBe('en')
    // 只改 settings 而不换翻译器，界面仍会是中文
    expect(state.t('nav.settings')).toBe('Settings')
  })

  it('updateSettings 落盘后刷新翻译器与主题(变异 M6)', async () => {
    const useAppStore = await freshStore()
    await useAppStore.getState().updateSettings({ language: 'en', theme: 'dark' })
    const state = useAppStore.getState()
    expect(updateCalls).toEqual([{ language: 'en', theme: 'dark' }])
    expect(state.language).toBe('en')
    expect(state.t('common.cancel')).toBe('Cancel')
    expect(state.theme).toBe('dark')
    expect((document.documentElement.dataset as Record<string, string>)['theme']).toBe('dark')
  })

  it('toggleTheme 经 updateSettings 落盘(R4:此前只改本地,重启被覆盖)', async () => {
    const useAppStore = await freshStore()
    await useAppStore.getState().hydrateSettings()
    useAppStore.getState().toggleTheme()
    // 必须产生一次设置写入，而不是只改内存
    await vi.waitFor(() => {
      expect(updateCalls).toEqual([{ theme: 'dark' }])
    })
  })

  it('updateSettings 失败必须抛出(R5:此前静默,界面仍提示「已保存」)', async () => {
    const useAppStore = await freshStore()
    updateResult = { ok: false, message: '磁盘满' }
    await expect(useAppStore.getState().updateSettings({ language: 'en' })).rejects.toThrow('磁盘满')
    // 失败不得污染本地偏好
    expect(useAppStore.getState().settings.language).toBe('zh')
  })

  it('subscribeSystemTheme 仅在偏好为 system 时跟随系统变化(R7)', async () => {
    const useAppStore = await freshStore()
    settingsValue = { ...DEFAULTS, theme: 'dark' }
    await useAppStore.getState().hydrateSettings()
    useAppStore.getState().subscribeSystemTheme()
    expect(themeListeners.length).toBe(1)

    // 显式 dark 偏好下，系统变化不得覆盖用户选择
    matchDark = false
    themeListeners.forEach((listener) => listener())
    expect(useAppStore.getState().theme).toBe('dark')

    // 切到 system 后，系统变化应生效
    await useAppStore.getState().updateSettings({ theme: 'system' })
    matchDark = true
    themeListeners.forEach((listener) => listener())
    expect(useAppStore.getState().theme).toBe('dark')

    matchDark = false
    themeListeners.forEach((listener) => listener())
    expect(useAppStore.getState().theme).toBe('light')
  })
})
