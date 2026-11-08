/**
 * 界面文案目录 —— 聚合器，纯数据，不 import electron/React。
 *
 * 语言按文件组织（catalog/zh.ts、catalog/en.ts …），此处只做两件事：
 * 1. 注册语言表，键集合以中文表为准，其余语言用 `satisfies` 对齐 —— 漏译（缺键）
 *    和多键都是编译错误，新增语言也只需「加一张表 + 注册一行」；
 * 2. 摊平成 key → { Language: 文案 }，调用方只按 key 和当前语言取值。
 *
 * 合并处的类型断言是全文件唯一一处：Object.fromEntries 无法保留键的联合类型，
 * 由各语言表的 satisfies 与 i18n.test.ts 的键集合用例共同兜底。
 */
import type { Language } from '../settings'
import { EN_MESSAGES } from './catalog/en'
import { ZH_MESSAGES } from './catalog/zh'

/** 文案键集合以中文表为准；其余语言表用 `satisfies Record<keyof typeof ZH_MESSAGES, string>` 对齐 */
export type MessageKey = keyof typeof ZH_MESSAGES

/** 一条文案在各语言下的取值 */
export type Message = { readonly [L in Language]: string }

/**
 * 语言表注册表。新增语言时：`Language` 加一个值、catalog 下加一张约束到中文键集合的表、
 * 这里补一行。少注册一种已声明的语言或多注册一种未声明的语言都会编译失败。
 */
const CATALOGS = {
  zh: ZH_MESSAGES,
  en: EN_MESSAGES
} as const satisfies Record<Language, Record<MessageKey, string>>

/** 按 key 合并所有语言，键顺序与 zh.ts 一致 */
export const MESSAGES = Object.fromEntries(
  (Object.keys(ZH_MESSAGES) as MessageKey[]).map((key) => [
    key,
    Object.fromEntries(
      (Object.keys(CATALOGS) as Language[]).map((language) => [language, CATALOGS[language][key]])
    )
  ])
) as { [K in MessageKey]: Message }

/** 从文案 key 推导的联合类型(供 UI 层与测试使用) */
export const MESSAGE_KEYS = Object.keys(ZH_MESSAGES) as MessageKey[]
