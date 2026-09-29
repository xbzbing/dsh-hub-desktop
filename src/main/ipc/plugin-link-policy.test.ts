import { describe, expect, it } from 'vitest'
import { isAllowedPluginLink } from './plugin-link-policy'

describe('isAllowedPluginLink', () => {
  it('放行 npmjs.com 与 github.com 的 https', () => {
    expect(isAllowedPluginLink('https://www.npmjs.com/package/@xbzbing/dsh-git-panel')).toBe(true)
    expect(isAllowedPluginLink('https://npmjs.com/package/x')).toBe(true)
    expect(isAllowedPluginLink('https://github.com/xbzbing/dsh-git-panel')).toBe(true)
  })

  it('拒绝非 https', () => {
    expect(isAllowedPluginLink('http://www.npmjs.com/package/x')).toBe(false)
    expect(isAllowedPluginLink('ftp://github.com/a/b')).toBe(false)
  })

  it('拒绝白名单外域名', () => {
    expect(isAllowedPluginLink('https://evil.example.com/x')).toBe(false)
    expect(isAllowedPluginLink('https://github.com.evil.com/a/b')).toBe(false)
  })

  it('拒绝内嵌凭据', () => {
    expect(isAllowedPluginLink('https://user:pass@github.com/a/b')).toBe(false)
  })

  it('拒绝无法解析的输入', () => {
    expect(isAllowedPluginLink('')).toBe(false)
    expect(isAllowedPluginLink('not a url')).toBe(false)
  })
})
