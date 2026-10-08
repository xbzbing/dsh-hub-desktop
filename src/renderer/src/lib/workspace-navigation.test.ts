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

  it('begin(id) 记录在途实例，clearInFlight 按 id+导航代只清自己的在途', () => {
    const guard = createNavigationGuard()
    expect(guard.inFlight()).toBeNull()
    const genA = guard.begin('a')
    expect(guard.inFlight()).toBe('a')
    // 后续导航切到别的实例：在途标记随之更新
    const genB = guard.begin('b')
    expect(guard.inFlight()).toBe('b')
    // 过期完成回调用旧 id+旧代清理，不能误清当前在途实例
    guard.clearInFlight('a', genA)
    expect(guard.inFlight()).toBe('b')
    guard.clearInFlight('b', genB)
    expect(guard.inFlight()).toBeNull()
  })

  it('换导航代后残留标记读作无在途（不抑制状态事件重触发）', () => {
    const guard = createNavigationGuard()
    guard.begin('a')
    // 不带 id 的导航（侧栏 starting 分支 / 切详情）也递增代号：旧标记视为过期
    guard.begin()
    expect(guard.inFlight()).toBeNull()
    // 过期代号的清理不影响之后新记录的在途
    const genC = guard.begin('c')
    guard.clearInFlight('c', genC - 1)
    expect(guard.inFlight()).toBe('c')
    guard.clearInFlight('c', genC)
    expect(guard.inFlight()).toBeNull()
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
