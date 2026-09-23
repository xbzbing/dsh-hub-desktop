import { describe, expect, it } from 'vitest'
import { instanceSwitchIndex } from './hotkeys'

function key(patch: Partial<Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'isComposing'>>): Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'isComposing'
> {
  return { key: '', code: '', metaKey: false, ctrlKey: false, isComposing: false, ...patch }
}

describe('instanceSwitchIndex', () => {
  it('按住 ⌘ 或 Ctrl 的数字键映射为 0 起下标', () => {
    expect(instanceSwitchIndex(key({ key: '1', code: 'Digit1', metaKey: true }))).toBe(0)
    expect(instanceSwitchIndex(key({ key: '9', code: 'Digit9', ctrlKey: true }))).toBe(8)
    expect(instanceSwitchIndex(key({ key: '3', code: 'Numpad3', metaKey: true }))).toBe(2)
  })

  it('缺 code 时按 key 兜底', () => {
    expect(instanceSwitchIndex(key({ key: '4', metaKey: true }))).toBe(3)
  })

  it('无修饰键、非数字键、0 都不切换', () => {
    expect(instanceSwitchIndex(key({ key: '1', code: 'Digit1' }))).toBeNull()
    expect(instanceSwitchIndex(key({ key: 'n', code: 'KeyN', metaKey: true }))).toBeNull()
    expect(instanceSwitchIndex(key({ key: '0', code: 'Digit0', metaKey: true }))).toBeNull()
  })

  it('输入法组合期间不接管', () => {
    expect(instanceSwitchIndex(key({ key: '1', code: 'Digit1', metaKey: true, isComposing: true }))).toBeNull()
  })
})
