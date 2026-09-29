import { describe, expect, it } from 'vitest'
import {
  canOfferUpgrade,
  initialCheckState,
  pluginKindKey,
  pluginSourceKey,
  pruneChecks,
  showsIncompatibleWarning,
  showsUpToDate,
  type PluginCheckState
} from './plugins-card-state'
import type { PluginUpdateCheck } from '@shared/contracts'

function check(overrides: Partial<PluginUpdateCheck>): PluginUpdateCheck {
  return {
    name: 'p',
    current: '1.0.0',
    latest: '1.1.0',
    hasUpdate: true,
    compatible: true,
    dshPeer: '>=0.1.7-rc.2',
    dshVersion: '0.1.7-rc.2',
    modifiedAt: null,
    ...overrides
  }
}

function done(result: PluginUpdateCheck): PluginCheckState {
  return { status: 'done', result, error: null }
}

describe('canOfferUpgrade', () => {
  it('检查完成、有新版且兼容 → true', () => {
    expect(canOfferUpgrade(done(check({ hasUpdate: true, compatible: true })))).toBe(true)
  })
  it('不兼容 → false', () => {
    expect(canOfferUpgrade(done(check({ hasUpdate: true, compatible: false })))).toBe(false)
  })
  it('无新版 → false', () => {
    expect(canOfferUpgrade(done(check({ hasUpdate: false })))).toBe(false)
  })
  it('未检查 → false', () => {
    expect(canOfferUpgrade(initialCheckState)).toBe(false)
  })
})

describe('showsIncompatibleWarning', () => {
  it('有新版但不兼容 → true', () => {
    expect(showsIncompatibleWarning(done(check({ hasUpdate: true, compatible: false })))).toBe(true)
  })
  it('兼容 → false', () => {
    expect(showsIncompatibleWarning(done(check({ hasUpdate: true, compatible: true })))).toBe(false)
  })
})

describe('showsUpToDate', () => {
  it('无新版 → true', () => {
    expect(showsUpToDate(done(check({ hasUpdate: false })))).toBe(true)
  })
  it('有新版 → false', () => {
    expect(showsUpToDate(done(check({ hasUpdate: true })))).toBe(false)
  })
})

describe('pluginKindKey', () => {
  it('host + client', () => {
    expect(pluginKindKey({ hasHostSide: true, hasClientSide: true })).toBe('detail.plugin.kind.hostClient')
  })
  it('仅 client', () => {
    expect(pluginKindKey({ hasHostSide: false, hasClientSide: true })).toBe('detail.plugin.kind.clientOnly')
  })
  it('仅 host', () => {
    expect(pluginKindKey({ hasHostSide: true, hasClientSide: false })).toBe('detail.plugin.kind.hostOnly')
  })
  it('都无', () => {
    expect(pluginKindKey({ hasHostSide: false, hasClientSide: false })).toBe('detail.plugin.kind.none')
  })
})

describe('pluginSourceKey', () => {
  it('各来源映射', () => {
    expect(pluginSourceKey('npm')).toBe('detail.plugin.source.npm')
    expect(pluginSourceKey('github')).toBe('detail.plugin.source.github')
    expect(pluginSourceKey('file')).toBe('detail.plugin.source.file')
    expect(pluginSourceKey('unknown')).toBe('detail.plugin.source.unknown')
  })
})

describe('pruneChecks', () => {
  const done: PluginCheckState = {
    status: 'done',
    result: {
      name: 'a',
      current: '1.0.0',
      latest: '1.0.0',
      hasUpdate: false,
      compatible: true,
      dshPeer: null,
      dshVersion: null,
      modifiedAt: null
    },
    error: null
  }

  it('保留仍在册插件的检查状态，剔除已卸载插件的项', () => {
    const checks = { a: done, b: { ...done }, c: { ...done } }
    const pruned = pruneChecks(checks, ['a', 'c'])
    expect(Object.keys(pruned).sort()).toEqual(['a', 'c'])
    expect(pruned.a).toBe(done)
  })

  it('空在册集合 → 全部剔除', () => {
    expect(pruneChecks({ a: done }, [])).toEqual({})
  })

  it('新装插件不凭空产生检查项（只保留已有）', () => {
    const pruned = pruneChecks({ a: done }, ['a', 'newly-installed'])
    expect(Object.keys(pruned)).toEqual(['a'])
  })
})
