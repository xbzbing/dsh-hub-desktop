import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getPreferredSystemLanguages = vi.fn(() => ['zh-Hans-CN', 'en'])
const getLocale = vi.fn(() => 'en-US')

vi.mock('electron', () => ({
  app: {
    getPreferredSystemLanguages: () => getPreferredSystemLanguages(),
    getLocale: () => getLocale()
  }
}))

import { systemLocale } from './system-locale'

describe('systemLocale', () => {
  beforeEach(() => {
    getPreferredSystemLanguages.mockReset()
    getLocale.mockReset()
    getPreferredSystemLanguages.mockImplementation(() => ['zh-Hans-CN', 'en'])
    getLocale.mockImplementation(() => 'en-US')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('DSH_HUB_E2E_LOCALE 钉住时优先于 OS 首选语言', () => {
    vi.stubEnv('DSH_HUB_E2E_LOCALE', 'zh-CN')
    expect(systemLocale()).toBe('zh-CN')
  })

  it('DSH_HUB_E2E_LOCALE 为空串时不生效,按正常回退解析', () => {
    vi.stubEnv('DSH_HUB_E2E_LOCALE', '  ')
    expect(systemLocale()).toBe('zh-Hans-CN')
  })

  it('优先返回 OS preferred languages 首项', () => {
    expect(systemLocale()).toBe('zh-Hans-CN')
  })

  it('preferred languages 为空时回退 app.getLocale()', () => {
    getPreferredSystemLanguages.mockImplementation(() => [])
    expect(systemLocale()).toBe('en-US')
  })

  it('preferred languages 抛错时回退 app.getLocale()', () => {
    getPreferredSystemLanguages.mockImplementation(() => {
      throw new Error('unavailable')
    })
    expect(systemLocale()).toBe('en-US')
  })
})
