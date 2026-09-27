import { describe, expect, it } from 'vitest'
import {
  createNavigationGuard,
  suspendForWizardPatch,
  toDetailPatch,
  toDisconnectedPatch,
  toOpenPatch,
  toOpeningPatch,
  toSettingsPatch
} from './workspace-navigation'

describe('createNavigationGuard', () => {
  it('begin 递增并返回本次代号，isCurrent 只认最新一次', () => {
    const guard = createNavigationGuard()
    const first = guard.begin()
    expect(guard.isCurrent(first)).toBe(true)
    const second = guard.begin()
    // 更新的导航意图使前一次代号失效——过期 openView 响应据此自我作废
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })

  it('bump 只推进代号，不返回值（用于「切走即作废」的同步入口）', () => {
    const guard = createNavigationGuard()
    const gen = guard.begin()
    guard.bump()
    expect(guard.isCurrent(gen)).toBe(false)
  })
})

describe('导航 patch 构造器', () => {
  it('toDetailPatch 清空挂起与待打开，退出设置页', () => {
    expect(toDetailPatch('a')).toEqual({
      selection: 'a',
      workspaceOpen: false,
      workspaceOpening: false,
      workspaceSuspended: false,
      settingsOpen: false,
      pendingOpen: []
    })
    expect(toDetailPatch(null).selection).toBeNull()
  })

  it('toOpeningPatch 进入加载中间页', () => {
    expect(toOpeningPatch('a')).toEqual({
      selection: 'a',
      workspaceOpen: false,
      workspaceOpening: true,
      settingsOpen: false
    })
  })

  it('toOpenPatch 标记实例已连接且不丢其他实例的连接态', () => {
    expect(toOpenPatch('a', { b: false })).toEqual({
      workspaceOpen: true,
      workspaceOpening: false,
      workspaceConnected: { b: false, a: true }
    })
  })

  it('toDisconnectedPatch 标记实例未连接', () => {
    expect(toDisconnectedPatch('a', { a: true }).workspaceConnected).toEqual({ a: false })
  })

  it('toSettingsPatch 打开时放弃选中与待打开，关闭时只清 settingsOpen', () => {
    expect(toSettingsPatch(true)).toEqual({
      settingsOpen: true,
      workspaceOpen: false,
      workspaceOpening: false,
      selection: null,
      workspaceSuspended: false,
      pendingOpen: []
    })
    expect(toSettingsPatch(false)).toEqual({
      settingsOpen: false,
      workspaceOpen: false,
      workspaceOpening: false
    })
  })

  it('suspendForWizardPatch 标记工作区已挂起可恢复', () => {
    expect(suspendForWizardPatch()).toEqual({
      workspaceOpen: false,
      workspaceOpening: false,
      workspaceSuspended: true
    })
  })
})
