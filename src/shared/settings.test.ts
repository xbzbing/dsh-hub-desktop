import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings, resolveLanguage, SettingsSchema } from './settings'

describe('settings（非敏感偏好）', () => {
  it('默认值:跟随系统语言与主题、不驻留托盘、不自启、开通知', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      language: 'system',
      theme: 'system',
      tray: false,
      autoStart: false,
      notifications: true,
      workspaceCacheSize: 3,
      npmRegistry: ''
    })
  })

  it('resolveLanguage:显式偏好优先,缺失时按系统语言推断', () => {
    expect(resolveLanguage('zh', 'en-US')).toBe('zh')
    expect(resolveLanguage('en', 'zh-CN')).toBe('en')
    expect(resolveLanguage('system', 'zh-CN')).toBe('zh')
    expect(resolveLanguage('system', 'en-US')).toBe('en')
    expect(resolveLanguage(null, 'zh-CN')).toBe('zh')
    expect(resolveLanguage(null, 'zh-Hant-TW')).toBe('zh')
    expect(resolveLanguage(undefined, 'en-GB')).toBe('en')
    // 无系统语言信息 → 回落 en(非中文环境)
    expect(resolveLanguage(null, null)).toBe('en')
    expect(resolveLanguage(null, undefined)).toBe('en')
  })

  it('合法输入原样通过', () => {
    const input = {
      language: 'en',
      theme: 'dark',
      tray: true,
      autoStart: true,
      notifications: false,
      workspaceCacheSize: 7,
      npmRegistry: 'https://registry.npmmirror.com'
    }
    expect(normalizeSettings(input)).toEqual(input)
  })

  it('逐字段收敛:一个坏字段不重置整份偏好', () => {
    const normalized = normalizeSettings({
      language: 'en',
      theme: 'rainbow', // 非法
      tray: 'yes', // 非法
      autoStart: true,
      notifications: false
      // workspaceCacheSize 缺失 → 回落默认
    })
    expect(normalized).toEqual({
      language: 'en', // 保留
      theme: 'system', // 回落默认
      tray: false, // 回落默认
      autoStart: true, // 保留
      notifications: false, // 保留
      workspaceCacheSize: 3, // 缺失回落默认
      npmRegistry: '' // 缺失回落默认
    })
  })

  it('非对象输入回落默认', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS)
  })

  it('缺字段补默认(向后兼容:新增设置项不破坏旧文件)', () => {
    expect(normalizeSettings({ language: 'en' })).toEqual({
      ...DEFAULT_SETTINGS,
      language: 'en'
    })
  })

  it('schema 不落 `system` 之外的语言值', () => {
    expect(SettingsSchema.safeParse({ language: 'fr' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ theme: 'system' }).success).toBe(true)
  })

  it('npm 镜像信任根:只接受 https,本地镜像放行回环 http', () => {
    expect(SettingsSchema.safeParse({ npmRegistry: 'https://registry.npmmirror.com' }).success).toBe(true)
    expect(SettingsSchema.safeParse({ npmRegistry: 'https://[::1]:4873/' }).success).toBe(true)
    expect(SettingsSchema.safeParse({ npmRegistry: 'http://127.0.0.1:4873' }).success).toBe(true)
    expect(SettingsSchema.safeParse({ npmRegistry: 'http://localhost:4873' }).success).toBe(true)
    expect(SettingsSchema.safeParse({ npmRegistry: '' }).success).toBe(true)

    // registry 自证完整性且执行生命周期脚本,是整条下载链的信任根:
    // 其余协议与明文远程源一律拒绝。
    expect(SettingsSchema.safeParse({ npmRegistry: 'file:///tmp/evil-registry' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ npmRegistry: 'ftp://example.com/' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ npmRegistry: 'javascript:alert(1)' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ npmRegistry: 'http://evil.example.com/' }).success).toBe(false)
    expect(SettingsSchema.safeParse({ npmRegistry: 'not a url' }).success).toBe(false)
  })

  it('非法镜像地址经 normalizeSettings 回落默认,其余字段不受影响', () => {
    expect(normalizeSettings({ language: 'en', npmRegistry: 'file:///tmp/x' })).toEqual({
      ...DEFAULT_SETTINGS,
      language: 'en',
      npmRegistry: ''
    })
  })
})
