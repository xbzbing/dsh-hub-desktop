import { describe, expect, it } from 'vitest'
import { hasSwitchModifier, hotkeyDigitIndex, isModifierKey, switchModifierKey } from './hotkeys'

describe('hotkeyDigitIndex', () => {
  it('主键盘 Digit1-9 映射为 0-8', () => {
    expect(hotkeyDigitIndex('1', 'Digit1')).toBe(0)
    expect(hotkeyDigitIndex('5', 'Digit5')).toBe(4)
    expect(hotkeyDigitIndex('9', 'Digit9')).toBe(8)
  })

  it('小键盘 Numpad1-9 同样接受', () => {
    expect(hotkeyDigitIndex('3', 'Numpad3')).toBe(2)
  })

  it('无 code 时按单字符 key 兜底', () => {
    expect(hotkeyDigitIndex('2', '')).toBe(1)
    expect(hotkeyDigitIndex('7', 'Unidentified')).toBe(6)
  })

  it('0 与非数字键一律返回 null(最多 9 个实例参与切换)', () => {
    expect(hotkeyDigitIndex('0', 'Digit0')).toBeNull()
    expect(hotkeyDigitIndex('1', 'Digit1')).not.toBeNull()
    expect(hotkeyDigitIndex('n', 'KeyN')).toBeNull()
    expect(hotkeyDigitIndex('!', 'Digit1')).toBe(0)
    expect(hotkeyDigitIndex('', '')).toBeNull()
  })
})

describe('switchModifierKey / hasSwitchModifier', () => {
  it('macOS 用 Meta(⌘)，其余平台用 Alt', () => {
    expect(switchModifierKey('darwin')).toBe('Meta')
    expect(switchModifierKey('win32')).toBe('Alt')
    expect(switchModifierKey('linux')).toBe('Alt')
  })

  it('macOS 只认 Meta 按住，Alt 不触发', () => {
    expect(hasSwitchModifier('darwin', { meta: true, alt: false })).toBe(true)
    expect(hasSwitchModifier('darwin', { meta: false, alt: true })).toBe(false)
  })

  it('Windows/Linux 只认 Alt 按住，Meta(Win 键) 不触发', () => {
    expect(hasSwitchModifier('win32', { meta: false, alt: true })).toBe(true)
    expect(hasSwitchModifier('win32', { meta: true, alt: false })).toBe(false)
    expect(hasSwitchModifier('linux', { meta: false, alt: true })).toBe(true)
  })
})

describe('isModifierKey', () => {
  it('按住修饰键本身不算组合键', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']) {
      expect(isModifierKey(key)).toBe(true)
    }
  })

  it('字母、数字与其他按键算组合键里的实体键', () => {
    expect(isModifierKey('w')).toBe(false)
    expect(isModifierKey('W')).toBe(false)
    expect(isModifierKey('1')).toBe(false)
    expect(isModifierKey('Escape')).toBe(false)
    expect(isModifierKey('')).toBe(false)
  })
})
