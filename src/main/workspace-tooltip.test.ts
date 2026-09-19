import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    options: Record<string, unknown>
    setAlwaysOnTop = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setMenuBarVisibility = vi.fn()
    setBackgroundColor = vi.fn()
    loadURL = vi.fn(async () => undefined)
    setBounds = vi.fn()
    showInactive = vi.fn()
    hide = vi.fn()
    isDestroyed = vi.fn(() => false)
    destroy = vi.fn()

    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeBrowserWindow.instances.push(this)
    }
  }
  return { BrowserWindow: FakeBrowserWindow }
})

import { BrowserWindow } from 'electron'
import { createWorkspaceTooltipHost } from './workspace-tooltip'

interface TestWindow {
  options: Record<string, unknown>
  setAlwaysOnTop: ReturnType<typeof vi.fn>
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>
  setMenuBarVisibility: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

function windows(): TestWindow[] {
  return (BrowserWindow as unknown as { instances: TestWindow[] }).instances
}

function hubWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    getContentBounds: vi.fn(() => ({ x: 100, y: 200, width: 1200, height: 800 }))
  }
}

describe('createWorkspaceTooltipHost', () => {
  beforeEach(() => {
    windows().length = 0
  })

  it('uses a non-focusable native child window above the workspace view', async () => {
    const hub = hubWindow()
    const host = createWorkspaceTooltipHost(() => hub as never)

    await host.show({ text: '收起态示例实例', x: 72, y: 160 })

    const tooltip = windows()[0]
    expect(tooltip).toBeDefined()
    expect(tooltip?.options).toMatchObject({
      parent: hub,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      show: false
    })
    expect(tooltip?.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(tooltip?.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
    const bounds = tooltip?.setBounds.mock.calls.at(-1)?.[0]
    expect(bounds).toMatchObject({ x: 172, y: 343 })
    expect(bounds.width).toBeGreaterThanOrEqual(98)
    expect(bounds.height).toBe(34)
    expect(tooltip?.showInactive).toHaveBeenCalledOnce()
    const loaded = tooltip?.loadURL.mock.calls[0]?.[0] as string
    expect(decodeURIComponent(loaded)).toContain('margin:1px')
    expect(decodeURIComponent(loaded)).toContain('收起态示例实例')
  })

  it('hides without retaining a native overlay when the pointer leaves', async () => {
    const host = createWorkspaceTooltipHost(() => hubWindow() as never)
    await host.show({ text: '实例', x: 72, y: 160 })

    host.hide()

    expect(windows()[0]?.hide).toHaveBeenCalledOnce()
  })
})
