import { describe, expect, it } from 'vitest'
import { hotkeyDigitIndex } from './hotkeys'

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
