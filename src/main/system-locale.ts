import { app } from 'electron'

/**
 * 获取系统首选语言区域（如 `zh-Hans-CN`、`en-US`）。
 *
 * 优先使用 OS 级别的 preferred languages，不依赖 Chromium 内嵌语言包；
 * 打包后 `app.getLocale()` 可能因语言包缺失回落到 `en`，此处作为兜底。
 */
export function systemLocale(): string {
  // 测试钉子:E2E 显式指定语言,界面与工作区文案断言不随宿主系统语言漂移。
  const pinned = process.env['DSH_HUB_E2E_LOCALE']?.trim()
  if (pinned !== undefined && pinned !== '') return pinned
  try {
    const preferred = app.getPreferredSystemLanguages()
    if (preferred.length > 0 && preferred[0]) return preferred[0]
  } catch {
    // 忽略：某些平台/环境下 preferred languages 可能不可用，继续回退。
  }
  return app.getLocale()
}
