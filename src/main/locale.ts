/**
 * 系统区域设置检测。
 *
 * 打包后 Electron 的 app.getLocale() 依赖 Chromium 内部的 locale 解析，
 * 受 electronLanguages（.pak 文件）限制，可能无法正确映射系统语言
 * （如 macOS 的 zh-Hans-CN 在只有 en/zh_CN/zh_TW 的包里回落为 en）。
 * 本模块直接读 macOS 系统偏好获取首选语言，绕过 Chromium 的 locale 链路。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

/** macOS defaults read 返回的语言列表，如 ("zh-Hans-CN", "en") */
const APPLE_LANGUAGES_PATTERN = /"([^"]+)"/

async function readApplePreferredLanguage(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('defaults', ['read', '.GlobalPreferences', 'AppleLanguages'], {
      timeout: 2000
    })
    const match = APPLE_LANGUAGES_PATTERN.exec(stdout)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

let cachedLocale: string | null = null

/** 应用启动时调用一次，预热缓存。 */
export async function initLocale(): Promise<string> {
  cachedLocale = await detectLocale()
  return cachedLocale
}

/** 返回缓存的系统区域设置（同步，供主进程各处使用）。 */
export function getCachedLocale(): string {
  return cachedLocale ?? app.getLocale()
}

async function detectLocale(): Promise<string> {
  if (process.platform === 'darwin') {
    const lang = await readApplePreferredLanguage()
    if (lang) return lang
  }
  return app.getLocale()
}
