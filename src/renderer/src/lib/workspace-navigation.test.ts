import { describe, expect, it } from 'vitest'
import {
  createNavigationGuard,
  suspendForWizardPatch,
  toDetailPatch,
  toDisconnectedPatch,
  toOpenPatch,
  toOpeningPatch,
  toSettingsPatch,
  toWizardClosedPatch
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

  it('begin(id) 记录在途实例，clearInFlight 仅清同一实例', () => {
    const guard = createNavigationGuard()
    expect(guard.inFlight()).toBeNull()
    guard.begin('a')
    expect(guard.inFlight()).toBe('a')
    // 后续导航切到别的实例：在途标记随之更新
    guard.begin('b')
    expect(guard.inFlight()).toBe('b')
    // 过期完成回调用旧 id 清理，不能误清当前在途实例
    guard.clearInFlight('a')
    expect(guard.inFlight()).toBe('b')
    guard.clearInFlight('b')
    expect(guard.inFlight()).toBeNull()
  })

  it('begin() 不带 id 时不改变在途实例', () => {
    const guard = createNavigationGuard()
    guard.begin('a')
    guard.begin()
    expect(guard.inFlight()).toBe('a')
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

  it('toWizardClosedPatch：有可恢复目标时清挂起，无目标时只关向导', () => {
    expect(toWizardClosedPatch('a')).toEqual({ wizardOpen: false, workspaceSuspended: false })
    expect(toWizardClosedPatch(null)).toEqual({ wizardOpen: false })
  })
})
