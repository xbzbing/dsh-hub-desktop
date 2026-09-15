import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// electron 在 vitest node 环境不可加载——整体 mock 成可观测的假窗口,
// 证明 window-host 的守卫真正被接线(will-navigate 拦截/权限全拒/loadURL .catch/复用与关闭)
vi.mock('electron', () => {
  class FakeWebContents {
    handlers = new Map<string, (...args: unknown[]) => unknown>()
    setWindowOpenHandler = vi.fn()
    session = { setPermissionRequestHandler: vi.fn() }
    on = vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
      this.handlers.set(event, listener)
      return this
    })
    loadURL = vi.fn((_url: string) => Promise.resolve())
  }
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    webContents = new FakeWebContents()
    closedListener: (() => void) | null = null
    isDestroyed = vi.fn(() => false)
    setTitle = vi.fn()
    focus = vi.fn()
    close = vi.fn()
    // BrowserWindow.loadURL 委托给 webContents,保持一致
    loadURL = vi.fn((url: string) => this.webContents.loadURL(url))
    on = vi.fn((event: string, listener: () => void) => {
      if (event === 'closed') this.closedListener = listener
      return this
    })
    constructor() {
      FakeBrowserWindow.instances.push(this)
    }
  }
  return { BrowserWindow: FakeBrowserWindow }
})

import { BrowserWindow } from 'electron'
import { closeInstanceWindow, openInstanceWindow } from './window-host'

interface TestWin {
  webContents: {
    handlers: Map<string, (...args: unknown[]) => unknown>
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    session: { setPermissionRequestHandler: ReturnType<typeof vi.fn> }
    loadURL: ReturnType<typeof vi.fn>
  }
  closedListener: (() => void) | null
  isDestroyed: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

const fakeWindows = (): TestWin[] =>
  (BrowserWindow as unknown as { instances: TestWin[] }).instances

const ORIGIN = 'http://127.0.0.1:30000/?token=abc'
let seq = 0

beforeEach(() => {
  fakeWindows().length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('openInstanceWindow（实例窗口接线,§6.6 拦截外跳）', () => {
  it('会注册 will-navigate 守卫:同源回环放行,外部/跨端口跳转 preventDefault', () => {
    const win = openInstanceWindow({ instanceId: `n-${++seq}`, title: 't', url: ORIGIN }) as unknown as TestWin
    const navigate = win.webContents.handlers.get('will-navigate')
    expect(navigate).toBeDefined()

    const allowed = { preventDefault: vi.fn() }
    navigate?.(allowed, 'http://127.0.0.1:30000/api/jobs')
    expect(allowed.preventDefault).not.toHaveBeenCalled()

    const deniedExternal = { preventDefault: vi.fn() }
    navigate?.(deniedExternal, 'https://evil.example.com/phish')
    expect(deniedExternal.preventDefault).toHaveBeenCalledTimes(1)

    const deniedCrossPort = { preventDefault: vi.fn() }
    navigate?.(deniedCrossPort, 'http://127.0.0.1:30001/')
    expect(deniedCrossPort.preventDefault).toHaveBeenCalledTimes(1)

    const deniedNonHttp = { preventDefault: vi.fn() }
    navigate?.(deniedNonHttp, 'file:///etc/passwd')
    expect(deniedNonHttp.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('弹窗一律拒绝', () => {
    const win = openInstanceWindow({ instanceId: `w-${++seq}`, title: 't', url: ORIGIN }) as unknown as TestWin
    const handler = win.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as () => {
      action: string
    }
    expect(handler()).toEqual({ action: 'deny' })
  })

  it('实例分区会话的权限请求一律拒绝', () => {
    const win = openInstanceWindow({ instanceId: `p-${++seq}`, title: 't', url: ORIGIN }) as unknown as TestWin
    const setPerm = win.webContents.session.setPermissionRequestHandler
    expect(setPerm).toHaveBeenCalledTimes(1)
    const handler = setPerm.mock.calls[0]?.[0] as (
      _webContents: unknown,
      _permission: string,
      callback: (granted: boolean) => void
    ) => void
    const callback = vi.fn()
    handler(null, 'notifications', callback)
    expect(callback).toHaveBeenCalledWith(false)
  })

  it('窗口加载失败经 .catch 处理(不产生未处理拒绝)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const win = openInstanceWindow({ instanceId: `l-${++seq}`, title: 't', url: ORIGIN }) as unknown as TestWin
    // 复用分支的第二次加载失败 → .catch 兜住并记录主进程日志
    win.webContents.loadURL.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))
    openInstanceWindow({ instanceId: `l-${seq}`, title: 't2', url: ORIGIN })
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalled())
  })

  it('同实例复用窗口;close 后重新开窗', () => {
    const id = `r-${++seq}`
    const w1 = openInstanceWindow({ instanceId: id, title: 't', url: ORIGIN }) as unknown as TestWin
    const w2 = openInstanceWindow({ instanceId: id, title: 't2', url: ORIGIN }) as unknown as TestWin
    expect(w2).toBe(w1)
    expect(w2.setTitle).toHaveBeenCalledWith('t2')

    closeInstanceWindow(id)
    expect(w1.close).toHaveBeenCalledTimes(1)

    const w3 = openInstanceWindow({ instanceId: id, title: 't3', url: ORIGIN }) as unknown as TestWin
    expect(w3).not.toBe(w1)
  })
})