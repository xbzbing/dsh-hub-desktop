import { describe, expect, it, vi } from 'vitest'
import { toWorkspaceHotkey, type WorkspaceKeyInput } from './workspace-hotkey'

function input(patch: Partial<WorkspaceKeyInput>): WorkspaceKeyInput {
  return {
    type: 'keyDown',
    key: '',
    code: '',
    meta: false,
    control: false,
    isComposing: false,
    ...patch
  }
}

describe('toWorkspaceHotkey', () => {
  it('放行 ⌘/Ctrl 键本身,按 down/up 原样转发', () => {
    expect(toWorkspaceHotkey(input({ key: 'Meta', code: 'MetaLeft' }))).toEqual({
      phase: 'down',
      key: 'Meta',
      code: 'MetaLeft',
      meta: false,
      ctrl: false
    })
    expect(toWorkspaceHotkey(input({ type: 'keyUp', key: 'Control', code: 'ControlLeft', control: true }))).toEqual({
      phase: 'up',
      key: 'Control',
      code: 'ControlLeft',
      meta: false,
      ctrl: true
    })
  })

  it('放行按住 ⌘/Ctrl 时的数字键 1-9,并携带当时的修饰键状态', () => {
    expect(
      toWorkspaceHotkey(input({ key: '1', code: 'Digit1', meta: true }))
    ).toEqual({ phase: 'down', key: '1', code: 'Digit1', meta: true, ctrl: false })
    expect(toWorkspaceHotkey(input({ key: '9', code: 'Numpad9', control: true }))).toEqual({
      phase: 'down',
      key: '9',
      code: 'Numpad9',
      meta: false,
      ctrl: true
    })
    // 只有 key 的注入路径同样按数字识别
    expect(toWorkspaceHotkey(input({ key: '3', code: '', meta: true }))?.phase).toBe('down')
  })

  it('无修饰键的数字、数字键的 keyUp 都不转发', () => {
    expect(toWorkspaceHotkey(input({ key: '1', code: 'Digit1' }))).toBeNull()
    expect(toWorkspaceHotkey(input({ type: 'keyUp', key: '1', code: 'Digit1', meta: true }))).toBeNull()
    expect(toWorkspaceHotkey(input({ key: '0', code: 'Digit0', meta: true }))).toBeNull()
  })

  it('工作区自己的输入一律不转发也不拦截', () => {
    expect(toWorkspaceHotkey(input({ key: 'n', code: 'KeyN', meta: true }))).toBeNull()
    expect(toWorkspaceHotkey(input({ key: 'v', code: 'KeyV', control: true }))).toBeNull()
    expect(toWorkspaceHotkey(input({ type: 'char', key: '1', code: 'Digit1', meta: true }))).toBeNull()
    expect(toWorkspaceHotkey(input({ key: '1', code: 'Digit1', meta: true, isComposing: true }))).toBeNull()
  })

  it('过滤器是纯函数:不调用 preventDefault、不产生副作用', () => {
    const guard = vi.fn()
    toWorkspaceHotkey(input({ key: 'a', code: 'KeyA' }))
    expect(guard).not.toHaveBeenCalled()
  })
})
