import { app } from 'electron'
import { systemLocale } from './system-locale'

/**
 * 在 ready 前把 Chromium 语言钉为系统首选语言（`lang` 开关仅此时追加才生效）。
 *
 * 打包按 `electronLanguages` 裁剪 app 级 `.lproj` 后,Chromium 探测不到系统语言,
 * `getLocale()` 回落 `en-US`,`navigator.languages` 首项随之变成 `en-US`:
 * 工作区内的 dsh web 在实例没有已存语言偏好时按它检测界面语言,新实例会整站变英文。
 * Hub 自身 UI 不走这里(由 `systemLocale()` 解析),此开关只统一 dev 与打包产物的
 * Chromium 语言,使工作区 navigator 检测与系统语言一致。
 */
export function pinStartupLanguage(): void {
  // ready 前 app.getLocale() 返回空串:preferred languages 也不可用时不追加,保持 Chromium 默认解析。
  const locale = systemLocale()
  if (locale !== '') app.commandLine.appendSwitch('lang', locale)
}
