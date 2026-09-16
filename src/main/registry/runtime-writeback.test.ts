import { describe, expect, it } from 'vitest'
import { isEmptyPatch, runtimeWritebackPatch } from './runtime-writeback'

/**
 * 实机缺陷回归:external 接管事件只剩空补丁 → `instanceStore.update` 抛
 * 「补丁不能为空」→ 日志刷 `回写实例运行信息失败`。以下钉住三类来源的回写策略
 * 与「空补丁」边界。
 */
describe('runtimeWritebackPatch(运行信息回写决策)', () => {
  it('hub 来源:端口与版本都回写(local)', () => {
    const patch = runtimeWritebackPatch(
      { port: 30501, version: '0.1.5', runtimeSource: 'hub' },
      'local'
    )
    expect(patch).toEqual({ port: 30501, dshVersion: '0.1.5' })
  })

  it('ssh 传输:端口写 localPort(隧道本地口),不是 port', () => {
    const patch = runtimeWritebackPatch(
      { port: 41111, version: '0.1.5', runtimeSource: 'hub' },
      'ssh'
    )
    expect(patch).toEqual({ localPort: 41111, dshVersion: '0.1.5' })
  })

  it('PATH 来源:不回写版本(用户升级后不能被拖回旧版);端口仍回写', () => {
    const patch = runtimeWritebackPatch(
      { port: 52300, version: '0.1.5-rc.2', runtimeSource: 'path' },
      'local'
    )
    expect(patch).toEqual({ port: 52300 })
  })

  it('external 接管:端口与版本都不回写 —— 这正是空补丁的来源(实机缺陷)', () => {
    const patch = runtimeWritebackPatch({ port: 3080, runtimeSource: 'external' }, 'local')
    expect(patch).toEqual({})
    expect(isEmptyPatch(patch)).toBe(true)
  })

  it('external 重复接管(带空版本串):仍是空补丁,不得落到 store', () => {
    const patch = runtimeWritebackPatch(
      { port: 3080, version: '', runtimeSource: 'external' },
      'local'
    )
    expect(patch).toEqual({})
    expect(isEmptyPatch(patch)).toBe(true)
  })

  it('只有端口没有版本(hub 首启早期事件)→ 只回写端口', () => {
    expect(runtimeWritebackPatch({ port: 30001 }, 'local')).toEqual({ port: 30001 })
  })

  it('只有版本没有端口 → 只回写版本', () => {
    expect(runtimeWritebackPatch({ version: '0.1.5', runtimeSource: 'hub' }, 'local')).toEqual({
      dshVersion: '0.1.5'
    })
  })

  it('空版本串不被当成有效版本(写出空串会把版本「清空」)', () => {
    expect(runtimeWritebackPatch({ version: '' }, 'local')).toEqual({})
  })

  it('既无端口也无版本(如 stopped 事件)→ 空补丁', () => {
    expect(runtimeWritebackPatch({}, 'local')).toEqual({})
    expect(isEmptyPatch(runtimeWritebackPatch({}, undefined))).toBe(true)
  })

  it('transport 未知(记录已被删除)→ 端口按普通字段回写,不误写 localPort', () => {
    expect(runtimeWritebackPatch({ port: 30002 }, undefined)).toEqual({ port: 30002 })
  })
})
