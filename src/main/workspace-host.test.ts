import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class FakeWebContents {
    handlers = new Map<string, (...args: unknown[]) => void>()
    loadURL = vi.fn(async () => undefined)
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

  it('creates a main-owned, sandboxed view with popup, permission, download, and navigation guards', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    const view = host.prepare('11111111-1111-4111-8111-111111111111', 'http://127.0.0.1:3080/?token=abc')
    const created = fakeViews()[0]
    expect(created).toBeDefined()
    expect(hub.contentView.addChildView).toHaveBeenCalledWith(created)
    host.setBounds({ x: 64, y: 92, width: 1116, height: 688 })
    expect(created?.setBounds).toHaveBeenCalledWith({ x: 64, y: 92, width: 1116, height: 688 })
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
    const host = createWorkspaceHost(() => hubWindow() as never)
    host.prepare('44444444-4444-4444-8444-444444444444', 'https://gw.example.com/login')
    const created = fakeViews()[0]

    expect(created?.setVisible).toHaveBeenCalledWith(false)
    host.setBounds({ x: 262, y: 46, width: 918, height: 734 })
    expect(created?.setBounds).toHaveBeenCalledWith({ x: 262, y: 46, width: 918, height: 734 })
    expect(created?.setVisible).toHaveBeenLastCalledWith(true)
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
