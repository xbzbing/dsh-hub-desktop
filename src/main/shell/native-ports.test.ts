import { describe, expect, it, vi } from 'vitest'
import type { HubTrayLabels } from '../tray'
import { createHubNativePorts } from './native-ports'
import { createNativeSettingsApplier } from './native-settings'

/**
 *
 * - `updateTray: () => {}`(托盘菜单永不刷新);
 * - `setLoginItem` 不落到 OS;
 * - `trayExists: () => false`。
 */

interface FakeTray {
  destroy(): void
}

/** 取出第 n 次调用的实参(noUncheckedIndexedAccess 下不裸下标) */
function callArgs<A extends readonly unknown[]>(mock: { mock: { calls: A[] } }, index = 0): A {
  const call = mock.mock.calls[index]
  if (!call) throw new Error(`期望至少有 ${index + 1} 次调用`)
  return call
}

function makeHarness() {
  const tray: FakeTray = { destroy: vi.fn() }
  const labelsSeen: HubTrayLabels[] = []
  let seq = 0
  const labels = (): HubTrayLabels => {
    const value: HubTrayLabels = {
      tooltip: `tip-${seq}`,
      show: 'show',
      quit: 'quit',
      // 状态行每次求值都不同:断言「刷新用的是最新文案」而不是创建时那一份
      status: `status-${++seq}`
    }
    labelsSeen.push(value)
    return value
  }
  const deps = {
    iconPath: vi.fn(() => '/resources/trayTemplate.png'),
    labels: vi.fn(labels),
    createTray: vi.fn(() => {
      return tray
    }),
    refreshTrayMenu: vi.fn(),
    applyLoginItem: vi.fn(),
    onShow: vi.fn(),
    onQuit: vi.fn(),
    onError: vi.fn()
  }
  return { deps, tray, labelsSeen }
}

describe('createHubNativePorts（效果侧:托盘 / 登录项真的落到 electron）', () => {
  it('托盘存在性来自真实引用(「trayExists 恒 false」的锚点)', () => {
    const { deps, tray } = makeHarness()
    const ports = createHubNativePorts<FakeTray>(deps)

    expect(ports.trayExists()).toBe(false)
    expect(ports.currentTray()).toBeNull()

    ports.createTray()
    expect(ports.trayExists()).toBe(true)
    expect(ports.currentTray()).toBe(tray)

    ports.destroyTray()
    expect(ports.trayExists()).toBe(false)
    expect(ports.currentTray()).toBeNull()
    expect(tray.destroy).toHaveBeenCalledTimes(1)
  })

  it('创建托盘时把图标路径、最新文案与回调交给 electron', () => {
    const { deps, labelsSeen } = makeHarness()
    createHubNativePorts<FakeTray>(deps).createTray()

    expect(deps.iconPath).toHaveBeenCalledTimes(1)
    expect(deps.labels).toHaveBeenCalledTimes(1)
    expect(deps.createTray).toHaveBeenCalledWith({
      iconPath: '/resources/trayTemplate.png',
      labels: labelsSeen.at(-1),
      onShow: deps.onShow,
      onQuit: deps.onQuit
    })
  })

  it('updateTray 真的刷新菜单,并携带**重新求值**的文案(「updateTray 空实现」的锚点)', () => {
    const { deps, tray, labelsSeen } = makeHarness()
    const ports = createHubNativePorts<FakeTray>(deps)
    ports.createTray()
    const labelsAtCreate = deps.labels.mock.calls.length

    ports.updateTray()

    expect(deps.refreshTrayMenu).toHaveBeenCalledTimes(1)
    const [calledTray, calledLabels, onShow, onQuit] = callArgs(deps.refreshTrayMenu)
    expect(calledTray).toBe(tray)
    // 语言/实例数可能在创建之后变了:必须是新求值的文案,不是创建时那一份
    expect(deps.labels.mock.calls.length).toBe(labelsAtCreate + 1)
    expect(calledLabels).toBe(labelsSeen.at(-1))
    expect(onShow).toBe(deps.onShow)
    expect(onQuit).toBe(deps.onQuit)
  })

  it('没有托盘时 updateTray 不触碰 electron(创建失败也不抛错)', () => {
    const { deps } = makeHarness()
    const ports = createHubNativePorts<FakeTray>(deps)
    expect(() => ports.updateTray()).not.toThrow()
    expect(deps.refreshTrayMenu).not.toHaveBeenCalled()
    expect(deps.labels).not.toHaveBeenCalled()
  })

  it('setLoginItem 真的把登录项写进 OS(「不再落到 OS」的锚点)', () => {
    const { deps } = makeHarness()
    const ports = createHubNativePorts<FakeTray>(deps)

    ports.setLoginItem(true)
    expect(deps.applyLoginItem).toHaveBeenCalledWith({ openAtLogin: true, openAsHidden: true })

    ports.setLoginItem(false)
    expect(deps.applyLoginItem).toHaveBeenLastCalledWith({
      openAtLogin: false,
      openAsHidden: false
    })
  })

  it('与既有 applier 串联:开启→真的建托盘与登录项,再次 apply→真的刷新菜单,关闭→真的销毁', () => {
    const { deps, tray } = makeHarness()
    const ports = createHubNativePorts<FakeTray>(deps)
    const applier = createNativeSettingsApplier(ports)

    applier.apply({ tray: true, autoStart: true }, { startup: false })
    expect(deps.createTray).toHaveBeenCalledTimes(1)
    expect(deps.applyLoginItem).toHaveBeenCalledWith({ openAtLogin: true, openAsHidden: true })

    // 托盘已存在 → 刷新文案而不是重复创建(否则菜单栏会堆图标)
    applier.apply({ tray: true, autoStart: true }, { startup: false })
    expect(deps.createTray).toHaveBeenCalledTimes(1)
    expect(deps.refreshTrayMenu).toHaveBeenCalledTimes(1)

    applier.apply({ tray: false, autoStart: false }, { startup: false })
    expect(tray.destroy).toHaveBeenCalledTimes(1)
    expect(ports.currentTray()).toBeNull()
  })
})
