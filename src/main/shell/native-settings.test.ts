import { describe, expect, it } from 'vitest'
import { planNativeSettings } from './native-settings'

const T = (tray: boolean, autoStart = false) => ({ tray, autoStart })

describe('planNativeSettings（T11 设置 → 原生动作）', () => {
  it('托盘:开→无 创建;有→关 销毁', () => {
    expect(planNativeSettings({ settings: T(true), trayExists: false, startup: false })).toEqual([
      { kind: 'create-tray' },
      { kind: 'set-login-item', autoStart: false }
    ])
    expect(
      planNativeSettings({ settings: T(false), trayExists: true, startup: false })
    ).toContainEqual({ kind: 'destroy-tray' })
  })

  it('托盘已存在且仍开启 → **刷新文案**(R3:切换语言后菜单不能停在旧语言)', () => {
    // 变异「托盘已存在时什么都不做」会让本用例失败
    expect(planNativeSettings({ settings: T(true), trayExists: true, startup: false })).toContainEqual(
      { kind: 'update-tray' }
    )
  })

  it('启动时只在需要开启时写登录项(避免无意义地写「关闭」)', () => {
    const off = planNativeSettings({ settings: T(false, false), trayExists: false, startup: true })
    expect(off.some((action) => action.kind === 'set-login-item')).toBe(false)

    const on = planNativeSettings({ settings: T(false, true), trayExists: false, startup: true })
    expect(on).toContainEqual({ kind: 'set-login-item', autoStart: true })
  })

  it('运行期切换自启必须落到 OS(含关闭)', () => {
    expect(
      planNativeSettings({ settings: T(false, true), trayExists: false, startup: false })
    ).toContainEqual({ kind: 'set-login-item', autoStart: true })
    expect(
      planNativeSettings({ settings: T(false, false), trayExists: false, startup: false })
    ).toContainEqual({ kind: 'set-login-item', autoStart: false })
  })

  it('关托盘时不产生创建/刷新动作(不留下无用图标)', () => {
    const actions = planNativeSettings({ settings: T(false), trayExists: false, startup: false })
    expect(actions.some((a) => a.kind === 'create-tray' || a.kind === 'update-tray')).toBe(false)
  })
})
