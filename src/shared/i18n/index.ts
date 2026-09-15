/**
 * 翻译器（T11）—— 纯函数,不 import electron/React。
 *
 * `t(key, params)` 的 key 受字面量联合类型约束(拼错编译不过),插值用 `{name}`。
 * 缺失插值参数时**保留占位符原样**而不是渲染 `undefined`:漏参是显式可见的,
 * 不会悄悄显示成 "undefined" 让用户困惑。
 */
import type { Language } from '../settings'
import { MESSAGES, type MessageKey } from './messages'

export type TranslateParams = Record<string, string | number>

/** 插值:`{name}` → 参数值;缺参保留占位符 */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

export type Translator = (key: MessageKey, params?: TranslateParams) => string

/** 取某语言下的文案(未知 key 返回 key 本身,便于在 UI 上直接看出漏配) */
export function translate(language: Language, key: MessageKey, params?: TranslateParams): string {
  const message = MESSAGES[key] as { zh: string; en: string } | undefined
  if (!message) return key
  return interpolate(message[language], params)
}

export function createTranslator(language: Language): Translator {
  return (key, params) => translate(language, key, params)
}
