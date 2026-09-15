import { describe, expect, it } from 'vitest'
import { loginItemSettings, shouldMinimizeToTrayOnClose, shouldNotifyStatus } from './native-decisions'

describe('native-decisions（T11 设置 → 原生行为）', () => {
  const on = { notifications: true }

  it('运行/失败状态变化会通知', () => {
    expect(shouldNotifyStatus({ status: 'running' }, 'starting', on)).toBe(true)
    expect(shouldNotifyStatus({ status: 'error' }, 'running', on)).toBe(true)
  })

  it('关掉通知偏好后一律不通知', () => {
    expect(shouldNotifyStatus({ status: 'running' }, 'starting', { notifications: false })).toBe(
      false
    )
  })

  it('首次观测不通知(启动时重放状态不该弹一堆「运行中」)', () => {
    expect(shouldNotifyStatus({ status: 'running' }, null, on)).toBe(false)
    expect(shouldNotifyStatus({ status: 'error' }, null, on)).toBe(false)
  })

  it('状态未变化不重复通知', () => {
    expect(shouldNotifyStatus({ status: 'running' }, 'running', on)).toBe(false)
    expect(shouldNotifyStatus({ status: 'error' }, 'error', on)).toBe(false)
  })

  it('stopped / starting 不打扰用户', () => {
    expect(shouldNotifyStatus({ status: 'stopped' }, 'running', on)).toBe(false)
    expect(shouldNotifyStatus({ status: 'starting' }, 'stopped', on)).toBe(false)
  })

  it('托盘偏好 + 托盘存在才隐藏窗口', () => {
    expect(shouldMinimizeToTrayOnClose({ tray: true }, true)).toBe(true)
    expect(shouldMinimizeToTrayOnClose({ tray: false }, true)).toBe(false)
  })

  it('偏好开着但没有托盘时绝不隐藏(否则应用叫不回来)', () => {
    expect(shouldMinimizeToTrayOnClose({ tray: true }, false)).toBe(false)
  })

  it('自启设置映射为登录项(自启时不抢焦点)', () => {
    expect(loginItemSettings({ autoStart: true })).toEqual({ openAtLogin: true, openAsHidden: true })
    expect(loginItemSettings({ autoStart: false })).toEqual({
      openAtLogin: false,
      openAsHidden: false
    })
  })
})
