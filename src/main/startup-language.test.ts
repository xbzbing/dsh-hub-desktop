import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appendSwitch = vi.fn()
const getPreferredSystemLanguages = vi.fn(() => ['zh-Hans-CN', 'en'])
const getLocale = vi.fn(() => 'en-US')

vi.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: (name: string, value: string) => appendSwitch(name, value) },
    getPreferredSystemLanguages: () => getPreferredSystemLanguages(),
    getLocale: () => getLocale()
  }
}))

import { pinStartupLanguage } from './startup-language'

describe('pinStartupLanguage', () => {
  beforeEach(() => {
    appendSwitch.mockReset()
    getPreferredSystemLanguages.mockReset()
    getLocale.mockReset()
    getPreferredSystemLanguages.mockImplementation(() => ['zh-Hans-CN', 'en'])
    getLocale.mockImplementation(() => 'en-US')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('以系统首选语言首项追加 lang 开关', () => {
    pinStartupLanguage()
    expect(appendSwitch).toHaveBeenCalledOnce()
    expect(appendSwitch).toHaveBeenCalledWith('lang', 'zh-Hans-CN')
  })

  it('DSH_HUB_E2E_LOCALE 钉住时以钉住值追加', () => {
    vi.stubEnv('DSH_HUB_E2E_LOCALE', 'zh-CN')
    pinStartupLanguage()
    expect(appendSwitch).toHaveBeenCalledWith('lang', 'zh-CN')
  })

  it('解析结果为空串时不追加,避免向 Chromium 传空语言', () => {
    getPreferredSystemLanguages.mockImplementation(() => [])
    getLocale.mockImplementation(() => '')
    pinStartupLanguage()
    expect(appendSwitch).not.toHaveBeenCalled()
  })
})
