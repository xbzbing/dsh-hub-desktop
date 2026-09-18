import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class FakeWebContents {
    handlers = new Map<string, (...args: unknown[]) => void>()
    loadURL = vi.fn(async () => undefined)
    focus = vi.fn()
    isDestroyed = vi.fn(() => false)
    getURL = vi.fn(() => '')
    setWindowOpenHandler = vi.fn()
    session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      on: vi.fn()
    }
    on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      this.handlers.set(event, listener)
    })
    close = vi.fn()
  }
  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    webContents = new FakeWebContents()
    setBounds = vi.fn()
    setVisible = vi.fn()
    constructor() {
      FakeWebContentsView.instances.push(this)
    }
  }
  return { WebContentsView: FakeWebContentsView }
})

import { WebContentsView } from 'electron'
import { createWorkspaceHost } from './workspace-host'

interface TestView {
  webContents: {
    handlers: Map<string, (...args: unknown[]) => void>
    loadURL: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
    getURL: ReturnType<typeof vi.fn>
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    session: {
      setPermissionRequestHandler: ReturnType<typeof vi.fn>
      setPermissionCheckHandler: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
    }
    close: ReturnType<typeof vi.fn>
  }
  setBounds: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
}

function fakeViews(): TestView[] {
  return (WebContentsView as unknown as { instances: TestView[] }).instances
}

function hubWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    // 暴露 focus 以便断言工作区路径**从不**抢宿主窗口焦点。
    focus: vi.fn(),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 1180, height: 780 })),
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn()
    }
  }
}

describe('createWorkspaceHost', () => {
  beforeEach(() => {
    fakeViews().length = 0
  })

  it('creates a main-owned, sandboxed view with popup, permission, download, and navigation guards', async () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    const view = host.prepare('11111111-1111-4111-8111-111111111111', 'http://127.0.0.1:3080/?token=abc')
    const created = fakeViews()[0]
    expect(created).toBeDefined()
    expect(hub.contentView.addChildView).toHaveBeenCalledWith(created)
    host.setBounds({ x: 64, y: 92, width: 1116, height: 688 })
    expect(created?.setBounds).toHaveBeenCalledWith({ x: 64, y: 92, width: 1116, height: 688 })
    await vi.waitFor(() => expect(created?.webContents.focus).toHaveBeenCalledTimes(1))
    // 绝不从工作区路径抢宿主窗口焦点：那会打断 macOS 的应用激活。
    expect(hub.focus).not.toHaveBeenCalled()
    // 后续布局变化不得再次抢夺焦点，否则会打断用户正在输入的登录表单。
    host.setBounds({ x: 64, y: 92, width: 1100, height: 688 })
    expect(created?.webContents.focus).toHaveBeenCalledTimes(1)
    expect(created?.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })

    const permissionRequest = created?.webContents.session.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      callback: (allowed: boolean) => void
    ) => void
    const callback = vi.fn()
    permissionRequest(null, 'notifications', callback)
    expect(callback).toHaveBeenCalledWith(false)
    expect(created?.webContents.session.setPermissionCheckHandler.mock.calls[0]?.[0]()).toBe(false)
    expect(created?.webContents.session.on).toHaveBeenCalledWith('will-download', expect.any(Function))

    for (const eventName of ['will-navigate', 'will-redirect']) {
      const navigate = created?.webContents.handlers.get(eventName)
      const denied = { preventDefault: vi.fn() }
      navigate?.(denied, 'https://evil.example.com/')
      expect(denied.preventDefault).toHaveBeenCalled()
      const allowed = { preventDefault: vi.fn() }
      navigate?.(allowed, 'http://localhost:3080/jobs')
      expect(allowed.preventDefault).not.toHaveBeenCalled()
    }

    void view.loadURL('http://127.0.0.1:3080/?token=abc')
    expect(created?.webContents.loadURL).toHaveBeenCalledWith('http://127.0.0.1:3080/?token=abc')
  })

  it('keeps a new workspace view hidden until the renderer supplies content bounds', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    host.prepare('44444444-4444-4444-8444-444444444444', 'https://gw.example.com/login')
    const created = fakeViews()[0]

    expect(created?.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    expect(created?.setVisible).toHaveBeenCalledWith(false)
    expect(created?.setBounds.mock.invocationCallOrder[0]).toBeLessThan(
      hub.contentView.addChildView.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    host.setBounds({ x: 262, y: 46, width: 918, height: 734 })
    expect(created?.setBounds).toHaveBeenCalledWith({ x: 262, y: 46, width: 918, height: 734 })
    expect(created?.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('does not reveal a replacement workspace using bounds cached for the previous view', () => {
    const host = createWorkspaceHost(() => hubWindow() as never)
    host.prepare('55555555-5555-4555-8555-555555555555', 'https://first.example.com/')
    host.setBounds({ x: 262, y: 46, width: 918, height: 734 })
    host.prepare('66666666-6666-4666-8666-666666666666', 'https://second.example.com/login')
    const replacement = fakeViews()[1]

    expect(replacement?.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    expect(replacement?.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('updates the navigation allowlist when a trusted reopen uses a new local port', () => {
    const host = createWorkspaceHost(() => hubWindow() as never)
    host.prepare('33333333-3333-4333-8333-333333333333', 'http://127.0.0.1:3080/')
    host.prepare('33333333-3333-4333-8333-333333333333', 'http://127.0.0.1:3081/')
    const navigate = fakeViews()[0]?.webContents.handlers.get('will-navigate')
    const allowed = { preventDefault: vi.fn() }
    navigate?.(allowed, 'http://127.0.0.1:3081/jobs')
    expect(allowed.preventDefault).not.toHaveBeenCalled()
  })

  it('按 LRU 保留有限数量的非活动工作区视图', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    host.setCacheLimit(2)
    host.prepare('11111111-1111-4111-8111-111111111111', 'http://127.0.0.1:3080/')
    host.prepare('22222222-2222-4222-8222-222222222222', 'http://127.0.0.1:3081/')
    host.prepare('33333333-3333-4333-8333-333333333333', 'http://127.0.0.1:3082/')

    expect(fakeViews()).toHaveLength(3)
    expect(hub.contentView.removeChildView).toHaveBeenCalledWith(fakeViews()[0])
    expect(fakeViews()[0]?.webContents.close).toHaveBeenCalled()
    expect(fakeViews()[1]?.webContents.close).not.toHaveBeenCalled()
    expect(fakeViews()[2]?.webContents.close).not.toHaveBeenCalled()
  })

  it('降低缓存上限时不回收当前可见工作区', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    host.setCacheLimit(3)
    host.prepare('11111111-1111-4111-8111-111111111111', 'http://127.0.0.1:3080/')
    host.prepare('22222222-2222-4222-8222-222222222222', 'http://127.0.0.1:3081/')
    host.prepare('33333333-3333-4333-8333-333333333333', 'http://127.0.0.1:3082/')

    host.setCacheLimit(1)
    expect(fakeViews()[0]?.webContents.close).toHaveBeenCalled()
    expect(fakeViews()[1]?.webContents.close).toHaveBeenCalled()
    expect(fakeViews()[2]?.webContents.close).not.toHaveBeenCalled()
  })

  it('hides and destroys guest views without exposing them to the renderer', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    host.prepare('22222222-2222-4222-8222-222222222222', 'http://127.0.0.1:3081/')
    const created = fakeViews()[0]
    host.hide()
    expect(created?.setVisible).toHaveBeenCalledWith(false)
    host.close('22222222-2222-4222-8222-222222222222')
    expect(hub.contentView.removeChildView).toHaveBeenCalledWith(created)
    expect(created?.webContents.close).toHaveBeenCalled()
  })
})
