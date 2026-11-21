import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { WORKSPACE_HOTKEY_EVENT } from '@shared/contracts'
import { installHotkeyFocusReset } from './hotkey-focus'

function fakeWindow(options: { destroyed?: boolean } = {}): {
  win: EventEmitter & {
    isDestroyed: () => boolean
    webContents: { send: ReturnType<typeof vi.fn> }
  }
  send: ReturnType<typeof vi.fn>
} {
  const send = vi.fn()
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => options.destroyed ?? false,
    webContents: { send }
  })
  return { win, send }
}

describe('installHotkeyFocusReset', () => {
  it('窗口失焦、重新聚焦与隐藏时向渲染层发送按住态重置', () => {
    const { win, send } = fakeWindow()
    installHotkeyFocusReset(win as never)

    for (const event of ['blur', 'focus', 'hide']) {
      win.emit(event)
      expect(send).toHaveBeenLastCalledWith(WORKSPACE_HOTKEY_EVENT, { phase: 'reset' })
    }
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('窗口已销毁时不再发送', () => {
    const { win, send } = fakeWindow({ destroyed: true })
    installHotkeyFocusReset(win as never)

    win.emit('blur')
    expect(send).not.toHaveBeenCalled()
  })
})
