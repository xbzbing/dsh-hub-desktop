import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/settings'
import type { VaultStatusSnapshot } from '@shared/contracts'
import { toStatusInfo } from './lib/format'

/**
 * store.ts tests run in Node, so browser globals are stubbed before dynamically importing the store.
 */

const DEFAULTS: Settings = {
  language: 'system',
  theme: 'system',
  tray: false,
  autoStart: false,
  notifications: true,
  workspaceCacheSize: 3,
  npmRegistry: ''
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
/** vault.status 的返回值；登录成功后就地刷新「凭证存储」依赖它 */
let vaultResult: { ok: true; value: VaultStatusSnapshot } | { ok: false; message: string }

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
  vaultResult = {
    ok: true,
    value: { available: true, degraded: false, rememberedInstances: [], policies: {} }
  }

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
      instances: { list: async () => ({ ok: true, value: [] }) },
      vault: { status: async () => vaultResult }
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
    expect(useAppStore.getState().settings.language).toBe('system')
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

  it('刷新列表用主进程运行态快照恢复已连接状态，避免侧栏回退为灰色', async () => {
    const useAppStore = await freshStore()
    settingsValue = { ...DEFAULTS }
    vi.stubGlobal('window', {
      ...window,
      dshHub: {
        ...window.dshHub,
        instances: {
          list: async () => ({
            ok: true as const,
            value: [
              {
                id: 'running-instance',
                name: '运行中实例',
                transport: 'local' as const,
                authMode: 'auto' as const,
                address: '127.0.0.1:3080',
                runtimeStatus: 'running' as const,
                updatedAt: '2026-09-16T00:00:00.000Z'
              }
            ]
          })
        }
      }
    })

    await useAppStore.getState().refreshList()
    expect(toStatusInfo(useAppStore.getState().statuses['running-instance']?.status).dotClass).toBe('s-connected')
  })

  it('打开向导前先隐藏工作区，避免原生视图覆盖弹窗；关闭后恢复同一缓存视图', async () => {
    const useAppStore = await freshStore()
    let resolveHide: (() => void) | undefined
    const hideView = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHide = resolve
        })
    )
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView } }
    })
    useAppStore.setState({ selection: 'instance-1', workspaceOpen: true })

    useAppStore.getState().setWizardOpen(true)
    expect(hideView).toHaveBeenCalledOnce()
    expect(useAppStore.getState().wizardOpen).toBe(false)
    expect(useAppStore.getState().workspaceOpen).toBe(false)
    expect(useAppStore.getState().workspaceSuspendedForWizard).toBe(true)

    resolveHide?.()
    await vi.waitFor(() => expect(useAppStore.getState().wizardOpen).toBe(true))

    useAppStore.getState().setWizardOpen(false)
    await vi.waitFor(() => expect(openView).toHaveBeenCalledWith('instance-1'))
    expect(useAppStore.getState().workspaceOpen).toBe(true)
  })


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

  it('断开工作区只清除工作区连接状态，不停止仍在运行的实例', async () => {
    const useAppStore = await freshStore()
    const disconnectView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { disconnectView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      statuses: { running: { id: 'running', status: 'running', at: '2026-09-18T00:00:00.000Z' } },
      workspaceConnected: { running: true }
    })

    await useAppStore.getState().disconnectWorkspace('running')

    expect(disconnectView).toHaveBeenCalledWith('running')
    expect(useAppStore.getState().workspaceConnected.running).toBe(false)
    expect(useAppStore.getState().statuses.running?.status).toBe('running')
  })

  it('断开后的运行实例按未连接展示，再次打开工作区后恢复已连接', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      selection: 'running',
      statuses: { running: { id: 'running', status: 'running', at: '2026-09-18T00:00:00.000Z' } },
      workspaceConnected: { running: false }
    })

    expect(toStatusInfo('running', useAppStore.getState().workspaceConnected.running).labelKey).toBe('state.idle')
    await useAppStore.getState().openWorkspace('running')
    expect(openView).toHaveBeenCalledWith('running')
    expect(useAppStore.getState().workspaceConnected.running).toBe(true)
    expect(toStatusInfo('running', useAppStore.getState().workspaceConnected.running).labelKey).toBe('state.connected')
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

  it('工作区已打开时重复打开同一实例不再隐藏和重开原生视图', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    const hideView = vi.fn()
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView } }
    })
    useAppStore.setState({ selection: 'instance-1', workspaceOpen: true })

    await useAppStore.getState().openWorkspace('instance-1')
    expect(hideView).not.toHaveBeenCalled()
    expect(openView).not.toHaveBeenCalled()
    expect(useAppStore.getState().workspaceOpen).toBe(true)
    expect(useAppStore.getState().workspaceOpening).toBe(false)
  })

  it('openView 在途时收到 running 状态不重复触发打开', async () => {
    const useAppStore = await freshStore()
    let resolveOpen!: (value: { ok: true; value: null }) => void
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
    useAppStore.setState({
      selection: 'instance-1',
      workspaceOpening: true,
      statuses: { 'instance-1': { id: 'instance-1', status: 'starting', at: '2026-09-18T00:00:00.000Z' } }
    })

    const opening = useAppStore.getState().openWorkspace('instance-1')
    useAppStore.getState().applyStatus({
      id: 'instance-1',
      status: 'running',
      at: '2026-09-18T00:00:01.000Z'
    })
    expect(openView).toHaveBeenCalledTimes(1)
    resolveOpen({ ok: true, value: null })
    await opening
    expect(useAppStore.getState()).toMatchObject({
      workspaceOpen: true,
      workspaceOpening: false
    })
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

  it('侧栏点击任意错误实例时直接进入详情，不发起必然失败的打开请求', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      instances: [
        {
          id: 'broken-ssh',
          name: '损坏 SSH 实例',
          transport: 'ssh',
          authMode: 'auto',
          address: 'dsh.internal:8080',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ],
      statuses: {
        'broken-ssh': {
          id: 'broken-ssh',
          status: 'error',
          at: '2026-09-18T00:00:00.000Z',
          detail: 'SSH 鉴权失败'
        }
      }
    })

    useAppStore.getState().openFromSidebar('broken-ssh')
    expect(useAppStore.getState().selection).toBe('broken-ssh')
    expect(useAppStore.getState().workspaceOpen).toBe(false)
    expect(useAppStore.getState().workspaceOpening).toBe(false)
    expect(openView).not.toHaveBeenCalled()
  })

  it('连接中实例在侧栏点击后保持加载页，收到运行状态后打开工作区', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      instances: [
        {
          id: 'starting-ssh',
          name: '连接中的 SSH 实例',
          transport: 'ssh',
          authMode: 'auto',
          address: 'dsh.internal:8080',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ],
      statuses: {
        'starting-ssh': {
          id: 'starting-ssh',
          status: 'starting',
          at: '2026-09-18T00:00:00.000Z'
        }
      }
    })

    useAppStore.getState().openFromSidebar('starting-ssh')
    expect(useAppStore.getState()).toMatchObject({
      selection: 'starting-ssh',
      workspaceOpening: true,
      workspaceOpen: false
    })
    expect(openView).not.toHaveBeenCalled()
    useAppStore.getState().applyStatus({
      id: 'starting-ssh',
      status: 'running',
      url: 'http://127.0.0.1:30000/',
      at: '2026-09-18T00:00:01.000Z'
    })
    await vi.waitFor(() => expect(openView).toHaveBeenCalledWith('starting-ssh'))
    expect(useAppStore.getState().workspaceOpen).toBe(true)
  })

  it('连接中实例收到失败状态时回到实例详情', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      instances: [
        {
          id: 'failed-ssh',
          name: '失败中的 SSH 实例',
          transport: 'ssh',
          authMode: 'auto',
          address: 'dsh.internal:8080',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ],
      statuses: {
        'failed-ssh': {
          id: 'failed-ssh',
          status: 'starting',
          at: '2026-09-18T00:00:00.000Z'
        }
      }
    })

    useAppStore.getState().openFromSidebar('failed-ssh')
    expect(useAppStore.getState().workspaceOpening).toBe(true)
    useAppStore.getState().applyStatus({
      id: 'failed-ssh',
      status: 'error',
      detail: 'SSH 隧道失败',
      at: '2026-09-18T00:00:01.000Z'
    })
    expect(useAppStore.getState()).toMatchObject({
      selection: 'failed-ssh',
      workspaceOpen: false,
      workspaceOpening: false
    })
  })

  it('侧栏点击非错误实例时仍按原流程打开工作区', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      instances: [
        {
          id: 'ready-local',
          name: '可用本机实例',
          transport: 'local',
          authMode: 'auto',
          address: '127.0.0.1:3080',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ]
    })

    useAppStore.getState().openFromSidebar('ready-local')
    await vi.waitFor(() => expect(openView).toHaveBeenCalledWith('ready-local'))
  })

  it('离开工作区前使在途打开失效，迟到完成不能重新显示原生视图', async () => {
    const useAppStore = await freshStore()
    let resolveOpen!: (value: { ok: true; value: null }) => void
    const hideView = vi.fn(async () => ({ ok: true as const, value: null }))
    const openView = vi.fn(
      () =>
        new Promise<{ ok: true; value: null }>((resolve) => {
          resolveOpen = resolve
        })
    )
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView } }
    })

    const opening = useAppStore.getState().openWorkspace('instance-a')
    useAppStore.getState().setSettingsOpen(true)
    resolveOpen({ ok: true, value: null })
    await opening

    expect(useAppStore.getState()).toMatchObject({
      settingsOpen: true,
      selection: null,
      workspaceOpen: false,
      workspaceOpening: false
    })
  })

  it('过期工作区打开完成不会隐藏后一次选择的原生视图', async () => {
    const useAppStore = await freshStore()
    let resolveA!: (value: { ok: true; value: null }) => void
    let resolveB!: (value: { ok: true; value: null }) => void
    const hideView = vi.fn(async () => ({ ok: true as const, value: null }))
    const openView = vi.fn((id: string) =>
      new Promise<{ ok: true; value: null }>((resolve) => {
        if (id === 'instance-a') resolveA = resolve
        else resolveB = resolve
      })
    )
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView } }
    })

    const first = useAppStore.getState().openWorkspace('instance-a')
    const second = useAppStore.getState().openWorkspace('instance-b')
    resolveB({ ok: true, value: null })
    await second
    resolveA({ ok: true, value: null })
    await first

    expect(useAppStore.getState()).toMatchObject({
      selection: 'instance-b',
      workspaceOpen: true,
      workspaceOpening: false
    })
    expect(hideView).toHaveBeenCalledTimes(2)
  })

  it('运行中的本机实例从详情打开工作区时不重复启动', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    const start = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, start, hideView: vi.fn() } }
    })

    useAppStore.setState({
      selection: 'running-local',
      statuses: {
        'running-local': { id: 'running-local', status: 'running', at: '2026-09-18T00:00:00.000Z' }
      }
    })
    await useAppStore.getState().openWorkspace('running-local')
    expect(openView).toHaveBeenCalledWith('running-local')
    expect(start).not.toHaveBeenCalled()
  })

  it('本机实例运行事件带实际端口时立即更新左侧列表地址', async () => {
    const useAppStore = await freshStore()
    useAppStore.setState({
      instances: [
        {
          id: 'auto-port-local',
          name: '自动端口实例',
          transport: 'local',
          authMode: 'auto',
          address: '127.0.0.1:—',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ]
    })

    useAppStore.getState().applyStatus({
      id: 'auto-port-local',
      status: 'running',
      port: 30123,
      at: '2026-09-18T00:00:01.000Z'
    })
    expect(useAppStore.getState().instances[0]?.address).toBe('127.0.0.1:30123')
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

describe('store vault', () => {
  it('refreshVault 写入主进程返回的最新快照', async () => {
    const useAppStore = await freshStore()
    expect(useAppStore.getState().vaultStatus).toBeNull()

    await useAppStore.getState().refreshVault()
    expect(useAppStore.getState().vaultStatus?.rememberedInstances).toEqual([])

    vaultResult = {
      ok: true,
      value: {
        available: true,
        degraded: false,
        rememberedInstances: ['instance-1'],
        policies: { 'instance-1': { rememberPassword: true, rememberSession: true } }
      }
    }
    await useAppStore.getState().refreshVault()
    expect(useAppStore.getState().vaultStatus?.rememberedInstances).toEqual(['instance-1'])
  })

  it('读取失败时保留上一份快照，不把已记住的凭据显示成未记住', async () => {
    const useAppStore = await freshStore()
    vaultResult = {
      ok: true,
      value: {
        available: true,
        degraded: false,
        rememberedInstances: ['instance-1'],
        policies: {}
      }
    }
    await useAppStore.getState().refreshVault()
    expect(useAppStore.getState().vaultStatus?.rememberedInstances).toEqual(['instance-1'])

    vaultResult = { ok: false, message: '保险库不可用' }
    await useAppStore.getState().refreshVault()
    expect(useAppStore.getState().vaultStatus?.rememberedInstances).toEqual(['instance-1'])
  })
})
