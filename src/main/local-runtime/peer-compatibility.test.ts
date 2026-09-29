import { describe, expect, it } from 'vitest'
import { githubUrlFrom, npmUrlFrom, satisfiesDshPeer } from './peer-compatibility'

describe('satisfiesDshPeer', () => {
  it('空/缺省范围视为无约束', () => {
    expect(satisfiesDshPeer(null, '0.1.7-rc.2')).toBe(true)
    expect(satisfiesDshPeer('', '0.1.7-rc.2')).toBe(true)
    expect(satisfiesDshPeer('*', '0.1.7-rc.2')).toBe(true)
  })

  it('范围非空但当前版本未知 → 不满足（宁可报不兼容）', () => {
    expect(satisfiesDshPeer('>=0.1.7-rc.2', null)).toBe(false)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '')).toBe(false)
  })

  it('>= 下限：prerelease 参与比较', () => {
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.7-rc.2')).toBe(true)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.7-rc.3')).toBe(true)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.7')).toBe(true)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.7-rc.1')).toBe(false)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.6')).toBe(false)
  })

  it('> < <= = 运算符', () => {
    expect(satisfiesDshPeer('>0.1.6', '0.1.7')).toBe(true)
    expect(satisfiesDshPeer('>0.1.7', '0.1.7')).toBe(false)
    expect(satisfiesDshPeer('<0.2.0', '0.1.9')).toBe(true)
    expect(satisfiesDshPeer('<=0.1.7', '0.1.7')).toBe(true)
    expect(satisfiesDshPeer('=0.1.7', '0.1.7')).toBe(true)
    expect(satisfiesDshPeer('=0.1.7', '0.1.8')).toBe(false)
  })

  it('裸版本按精确相等', () => {
    expect(satisfiesDshPeer('0.1.7', '0.1.7')).toBe(true)
    expect(satisfiesDshPeer('0.1.7', '0.1.8')).toBe(false)
  })

  it('caret ^ 范围', () => {
    expect(satisfiesDshPeer('^0.1.7', '0.1.9')).toBe(true)
    expect(satisfiesDshPeer('^0.1.7', '0.2.0')).toBe(false)
    expect(satisfiesDshPeer('^1.2.0', '1.9.9')).toBe(true)
    expect(satisfiesDshPeer('^1.2.0', '2.0.0')).toBe(false)
    expect(satisfiesDshPeer('^1.2.0', '1.1.0')).toBe(false)
  })

  it('tilde ~ 范围', () => {
    expect(satisfiesDshPeer('~1.2.3', '1.2.9')).toBe(true)
    expect(satisfiesDshPeer('~1.2.3', '1.3.0')).toBe(false)
    expect(satisfiesDshPeer('~1.2', '1.2.5')).toBe(true)
    expect(satisfiesDshPeer('~1', '1.9.0')).toBe(true)
    expect(satisfiesDshPeer('~1', '2.0.0')).toBe(false)
  })

  it('空格分隔的交集：两条件都要满足', () => {
    expect(satisfiesDshPeer('>=0.1.7-rc.2 <0.2.0', '0.1.9')).toBe(true)
    expect(satisfiesDshPeer('>=0.1.7-rc.2 <0.2.0', '0.2.0')).toBe(false)
    expect(satisfiesDshPeer('>=0.1.7-rc.2 <0.2.0', '0.1.6')).toBe(false)
  })

  it('|| 分隔的并集：任一子范围满足即可（memory-plugin 真实范围）', () => {
    const range = '>=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1 || ^0.1.7-rc.2'
    expect(satisfiesDshPeer(range, '0.1.7-rc.2')).toBe(true)
    expect(satisfiesDshPeer(range, '0.1.9')).toBe(true)
    expect(satisfiesDshPeer(range, '0.2.0')).toBe(false)
  })

  it('v 前缀被剥离', () => {
    expect(satisfiesDshPeer('>=v0.1.7', 'v0.1.7')).toBe(true)
  })

  it('git-panel 真实 peer：>=0.1.7-rc.2', () => {
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.7-rc.2')).toBe(true)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.5')).toBe(false)
  })
})

describe('githubUrlFrom', () => {
  it('git+https 带 .git 后缀', () => {
    expect(githubUrlFrom({ type: 'git', url: 'git+https://github.com/xbzbing/dsh-git-panel.git' })).toBe(
      'https://github.com/xbzbing/dsh-git-panel'
    )
  })

  it('字符串形态', () => {
    expect(githubUrlFrom('https://github.com/DDDMUC/dsh-free-search.git')).toBe(
      'https://github.com/DDDMUC/dsh-free-search'
    )
  })

  it('git@ SSH 形态', () => {
    expect(githubUrlFrom('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo')
  })

  it('github: 简写', () => {
    expect(githubUrlFrom('github:owner/repo')).toBe('https://github.com/owner/repo')
  })

  it('非 github 或空 → null', () => {
    expect(githubUrlFrom('https://gitlab.com/a/b.git')).toBe(null)
    expect(githubUrlFrom('')).toBe(null)
    expect(githubUrlFrom(null)).toBe(null)
    expect(githubUrlFrom(undefined)).toBe(null)
  })
})

describe('npmUrlFrom', () => {
  it('scoped 与 unscoped 包名', () => {
    expect(npmUrlFrom('@xbzbing/dsh-git-panel')).toBe('https://www.npmjs.com/package/@xbzbing/dsh-git-panel')
    expect(npmUrlFrom('dsh-free-search')).toBe('https://www.npmjs.com/package/dsh-free-search')
  })

  it('非法名 → null', () => {
    expect(npmUrlFrom('has space')).toBe(null)
    expect(npmUrlFrom('')).toBe(null)
  })
})
