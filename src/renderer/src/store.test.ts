import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/settings'
import { toStatusInfo } from './lib/format'

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

  it('load() 重复调用不泄漏系统主题监听(三审 Finding 3:变异「只读取消函数却不调用」)', async () => {
    const useAppStore = await freshStore()

    await useAppStore.getState().load()
    // App.tsx 会调用 load();React.StrictMode 在开发下**双调用** effect ——
    // 第二次必须先把上一次的订阅退掉,否则每挂载一次就多一个存活监听器
    await useAppStore.getState().load()

    // 取消了 1 次(第二次 load 才会遇到「上一次的订阅」),且任一时刻最多一个存活监听器。
    // 变异「void systemThemeUnsubscribe」会让 themeRemoves 停在 0、themeListeners 变 2。
    expect(themeAdds).toBe(2)
    expect(themeRemoves).toBe(1)
    expect(themeListeners.length).toBe(1)
    // 净订阅数必须等于存活监听器数:多出来的就是泄漏
    expect(themeAdds - themeRemoves).toBe(themeListeners.length)

    // 幸存的必须是**新**订阅(退订后又订阅回来了),仍在跟随系统
    matchDark = true
    themeListeners.forEach((listener) => listener())
    expect(useAppStore.getState().theme).toBe('dark')
  })

  it('toggleTheme 落盘失败必须提示 settings.saveFailed(三审 Finding 4:删掉整段 .catch 也全绿)', async () => {
    const useAppStore = await freshStore()
    await useAppStore.getState().hydrateSettings()
    const failureTitle = useAppStore.getState().t('settings.saveFailed')

    // 成功路径:落盘成功 → 不得出现失败提示
    useAppStore.getState().toggleTheme()
    await vi.waitFor(() => {
      expect(updateCalls).toEqual([{ theme: 'dark' }])
    })
    expect(useAppStore.getState().toasts.some((item) => item.title === failureTitle)).toBe(false)

    // 失败路径:updateSettings 真的抛(rejected)→ 必须以错误提示暴露,不能静默
    updateImpl = () => {
      throw new Error('磁盘满')
    }
    useAppStore.getState().toggleTheme()
    await vi.waitFor(() => {
      expect(useAppStore.getState().toasts.some((item) => item.title === failureTitle)).toBe(true)
    })
    const failureToast = useAppStore.getState().toasts.find((item) => item.title === failureTitle)
    expect(failureToast?.kind).toBe('err')
    // 失败不得把本地主题改掉(落盘没成功,界面就不该显示已生效)
    expect(useAppStore.getState().theme).toBe('dark')
  })

  /**
   * 用户反馈 #7:总览列表的状态原点恒为灰色。
   *
   * 缺陷本体是 HomeView 的圆点写死了类名(见 lib/format.test.ts 的源码护栏),
   * 但「圆点必须**实时**更新」还有一半在 store:选择器订阅的是 `statuses` 这个对象,
   * zustand 用 Object.is 比较选择器结果 —— 若 applyStatus **原地改**这个对象,
   * 订阅者收不到通知,列表就只在挂载/换行时定格。这里把「每次事件换引用」钉住。
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

    // 状态是**逐实例**的:另一个实例出错不得把 i1 的圆点带成红色
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
    // 既有语义(不改变):stopped 即移出切片 → 未知状态 → 灰点 idle
    expect(stopped['i1']).toBeUndefined()
    expect(toStatusInfo(stopped['i1']?.status).dotClass).toBe('')
  })
})
