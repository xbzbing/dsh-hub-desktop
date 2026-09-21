/**
 * 应用设置 —— 纯 schema，不 import electron。
 *
 * 只放**非敏感**偏好，敏感项一律走 vault，两者刻意不混。
 * 落盘在 `<userData>/settings.json`,损坏自愈为默认值(与注册表同一套纪律)。
 */
import { z } from 'zod'

export const LANGUAGES = ['system', 'zh', 'en'] as const
export const THEMES = ['system', 'light', 'dark'] as const

export type LanguagePreference = (typeof LANGUAGES)[number]
export type Language = Exclude<LanguagePreference, 'system'>
export type Theme = (typeof THEMES)[number]

export const SettingsSchema = z.object({
  /** 界面语言偏好；system 时解析为 OS locale 对应的 zh|en。 */
  language: z.enum(LANGUAGES).default('system'),
  theme: z.enum(THEMES).default('system'),
  /** 关闭窗口后最小化到托盘而非退出 */
  tray: z.boolean().default(false),
  /** 开机自启 */
  autoStart: z.boolean().default(false),
  /** 实例状态变化弹系统通知 */
  notifications: z.boolean().default(true),
  /** 内嵌工作区 WebContentsView 的 LRU 缓存上限(默认 3,防内存膨胀)。 */
  workspaceCacheSize: z.number().int().min(1).max(10).default(3)
})

export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/**
 * 解析实际生效的语言。
 *
 * 偏好是显式 `zh`/`en` 时直接用它;偏好为 `system`、缺失或无法判定时按系统语言推断
 * (中文环境 → zh,其余 → en)。单独抽出来是为了让「系统语言推断」可被穷举单测,
 * 而不是散落在渲染层的三元表达式里。
 */
export function resolveLanguage(preference: LanguagePreference | null | undefined, systemLocale?: string | null): Language {
  if (preference === 'zh' || preference === 'en') return preference
  const locale = (systemLocale ?? '').toLowerCase()
  return locale.startsWith('zh') ? 'zh' : 'en'
}

/**
 * 把未知输入收敛为合法设置:逐字段校验,非法字段回落默认值。
 *
 * 逐字段而非整体失败:设置文件里一个坏字段不该让整份偏好重置
 * (与注册表的「损坏自愈」同精神,但粒度更细)。
 */
export function normalizeSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS }
  const parsed = SettingsSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const raw = value as Record<string, unknown>
  const pick = <K extends keyof Settings>(key: K): Settings[K] => {
    const single = SettingsSchema.safeParse({ [key]: raw[key] })
    return single.success ? single.data[key] : DEFAULT_SETTINGS[key]
  }
  return {
    language: pick('language'),
    theme: pick('theme'),
    tray: pick('tray'),
    autoStart: pick('autoStart'),
    notifications: pick('notifications'),
    workspaceCacheSize: pick('workspaceCacheSize')
  }
}
