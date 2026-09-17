import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/settings'
import { toStatusInfo } from './lib/format'

/**
 * store.ts tests run in Node, so browser globals are stubbed before dynamically importing the store.
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
/** 订阅/退订**调用次数**(只看存活监听器数量抓不到「读了取消函数却没调用」的泄漏) */
let themeAdds: number
let themeRemoves: number
let matchDark: boolean
let storedTheme: string | null

function installGlobals(): void {
  settingsValue = { ...DEFAULTS }
  updateResult = null
  updateCalls = []
  updateImpl = null
  themeListeners = []
  themeAdds = 0
  themeRemoves = 0
  matchDark = false
  storedTheme = null

  const media = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => {
      themeAdds += 1
      themeListeners.push(listener)
    },
    removeEventListener: (_: string, listener: () => void) => {
      themeRemoves += 1
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

describe('store settings', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrateSettings 应用偏好语言并刷新翻译器', async () => {
    const useAppStore = await freshStore()
    settingsValue = { ...DEFAULTS, language: 'en' }
    await useAppStore.getState().hydrateSettings()
    const state = useAppStore.getState()
    expect(state.settings.language).toBe('en')
    expect(state.language).toBe('en')
    // 刷新翻译器后界面显示英文。
    expect(state.t('nav.settings')).toBe('Settings')
  })

  it('updateSettings 持久化后刷新翻译器与主题', async () => {
    const useAppStore = await freshStore()
    await useAppStore.getState().updateSettings({ language: 'en', theme: 'dark' })
    const state = useAppStore.getState()
    expect(updateCalls).toEqual([{ language: 'en', theme: 'dark' }])
    expect(state.language).toBe('en')
    expect(state.t('common.cancel')).toBe('Cancel')
    expect(state.theme).toBe('dark')
    expect((document.documentElement.dataset as Record<string, string>)['theme']).toBe('dark')
  })

  it('toggleTheme 通过 updateSettings 持久化', async () => {
    const useAppStore = await freshStore()
    await useAppStore.getState().hydrateSettings()
    useAppStore.getState().toggleTheme()
    // 必须产生一次设置写入，而不是只改内存
    await vi.waitFor(() => {
      expect(updateCalls).toEqual([{ theme: 'dark' }])
    })
  })

  it('updateSettings 失败时抛出错误', async () => {
    const useAppStore = await freshStore()
    updateResult = { ok: false, message: '磁盘满' }
    await expect(useAppStore.getState().updateSettings({ language: 'en' })).rejects.toThrow('磁盘满')
    // 失败不得污染本地偏好
    expect(useAppStore.getState().settings.language).toBe('zh')
  })

  it('subscribeSystemTheme 仅在偏好为 system 时跟随系统变化', async () => {
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

  it('load() 重复调用时只保留一个系统主题监听', async () => {
    const useAppStore = await freshStore()

    await useAppStore.getState().load()
    // 第二次加载前取消先前的订阅。
    await useAppStore.getState().load()

    // 保留一个监听器，并在下一次加载前取消前一个监听器。
    expect(themeAdds).toBe(2)
    expect(themeRemoves).toBe(1)
    expect(themeListeners.length).toBe(1)
    // 订阅和退订的差值等于当前存活的监听器数量。
    expect(themeAdds - themeRemoves).toBe(themeListeners.length)

    // 新订阅仍会跟随系统主题。
    matchDark = true
    themeListeners.forEach((listener) => listener())
    expect(useAppStore.getState().theme).toBe('dark')
  })

  it('toggleTheme 持久化失败时显示 settings.saveFailed', async () => {
    const useAppStore = await freshStore()
    await useAppStore.getState().hydrateSettings()
    const failureTitle = useAppStore.getState().t('settings.saveFailed')

    // 成功时不显示失败提示。
    useAppStore.getState().toggleTheme()
    await vi.waitFor(() => {
      expect(updateCalls).toEqual([{ theme: 'dark' }])
    })
    expect(useAppStore.getState().toasts.some((item) => item.title === failureTitle)).toBe(false)

    // 失败时显示错误提示。
    updateImpl = () => {
      throw new Error('磁盘满')
    }
    useAppStore.getState().toggleTheme()
    await vi.waitFor(() => {
      expect(useAppStore.getState().toasts.some((item) => item.title === failureTitle)).toBe(true)
    })
    const failureToast = useAppStore.getState().toasts.find((item) => item.title === failureTitle)
    expect(failureToast?.kind).toBe('err')
    // 失败不改变已应用的本地主题。
    expect(useAppStore.getState().theme).toBe('dark')
  })

  /**
   * applyStatus 创建新的状态对象，使 Zustand 订阅者接收到状态更新。
   */
  it('选中实例或回到总览都会退出设置页（设置页不能困住导航）', async () => {
    const useAppStore = await freshStore()
    useAppStore.getState().setSettingsOpen(true)
    expect(useAppStore.getState().settingsOpen).toBe(true)

    useAppStore.getState().select('instance-1')
    expect(useAppStore.getState().selection).toBe('instance-1')
    expect(useAppStore.getState().settingsOpen).toBe(false)

    useAppStore.getState().setSettingsOpen(true)
    useAppStore.getState().select(null)
    expect(useAppStore.getState().selection).toBeNull()
    expect(useAppStore.getState().settingsOpen).toBe(false)
  })

  it('打开工作区成功时先显示加载状态，再保留 selection 并显示内嵌工作区', async () => {
    const useAppStore = await freshStore()
    let resolveOpen: ((value: { ok: true; value: null }) => void) | undefined
    const openView = vi.fn(
      () =>
        new Promise<{ ok: true; value: null }>((resolve) => {
          resolveOpen = resolve
        })
    )
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.getState().select('instance-1')
    const opening = useAppStore.getState().openWorkspace('instance-1')
    expect(useAppStore.getState().selection).toBe('instance-1')
    expect(useAppStore.getState().workspaceOpening).toBe(true)
    expect(useAppStore.getState().workspaceOpen).toBe(false)

    resolveOpen?.({ ok: true, value: null })
    await opening
    expect(openView).toHaveBeenCalledWith('instance-1')
    expect(useAppStore.getState().workspaceOpening).toBe(false)
    expect(useAppStore.getState().workspaceOpen).toBe(true)
  })

  it('工作区打开失败后退出加载状态并保留实例详情', async () => {
    const useAppStore = await freshStore()
    vi.stubGlobal('window', {
      ...window,
      dshHub: {
        ...window.dshHub,
        runtime: {
          openView: vi.fn(async () => ({ ok: false, code: 'invalid-state', message: '连接失败' })),
          hideView: vi.fn()
        }
      }
    })

    await useAppStore.getState().openWorkspace('instance-1')
    expect(useAppStore.getState().selection).toBe('instance-1')
    expect(useAppStore.getState().workspaceOpening).toBe(false)
    expect(useAppStore.getState().workspaceOpen).toBe(false)
  })

  it('applyStatus 每次事件都换 statuses 引用(订阅者才会重渲染),圆点随之实时变化', async () => {
    const useAppStore = await freshStore()
    const before = useAppStore.getState().statuses

    // starting:未连接(灰)→ 连接中(蓝)
    useAppStore.getState().applyStatus({
      id: 'i1',
      status: 'starting',
      at: '2026-09-16T00:00:00.000Z'
    })
    const starting = useAppStore.getState().statuses
    expect(starting, 'statuses 必须是新对象,否则列表收不到状态事件').not.toBe(before)
    expect(toStatusInfo(starting['i1']?.status).dotClass).toBe('s-connecting')

    // running:连接中(蓝)→ 已连接(绿)。同一行**不重建**也要拿到新类名
    useAppStore.getState().applyStatus({
      id: 'i1',
      status: 'running',
      at: '2026-09-16T00:00:01.000Z'
    })
    const running = useAppStore.getState().statuses
    expect(running).not.toBe(starting)
    expect(toStatusInfo(running['i1']?.status).dotClass).toBe('s-connected')

    // 状态按实例隔离。
    useAppStore.getState().applyStatus({
      id: 'i2',
      status: 'error',
      at: '2026-09-16T00:00:02.000Z'
    })
    const mixed = useAppStore.getState().statuses
    expect(toStatusInfo(mixed['i1']?.status).dotClass).toBe('s-connected')
    expect(toStatusInfo(mixed['i2']?.status).dotClass).toBe('s-error')
  })

  it('applyStatus 的 stopped 事件清掉该实例状态(圆点回落到灰),不残留上一帧的绿点', async () => {
    const useAppStore = await freshStore()
    useAppStore.getState().applyStatus({
      id: 'i1',
      status: 'running',
      at: '2026-09-16T00:00:00.000Z'
    })
    expect(toStatusInfo(useAppStore.getState().statuses['i1']?.status).dotClass).toBe('s-connected')

    useAppStore.getState().applyStatus({
      id: 'i1',
      status: 'stopped',
      at: '2026-09-16T00:00:02.000Z'
    })
    const stopped = useAppStore.getState().statuses
    // stopped 时移除状态记录，展示回到 idle。
    expect(stopped['i1']).toBeUndefined()
    expect(toStatusInfo(stopped['i1']?.status).dotClass).toBe('')
  })
})
