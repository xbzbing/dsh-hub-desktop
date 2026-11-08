import type { Translator } from '@shared/i18n'
import { MESSAGE_KEYS, type MessageKey } from '@shared/i18n/messages'

const MESSAGE_KEY_SET = new Set<string>(MESSAGE_KEYS)

/**
 * 主进程可能把 schema 的稳定文案 key 放进 IPC 错误信封；
 * 渲染层在展示前把 key 换成当前语言。普通错误原样保留。
 */
export function localizeIpcMessage(t: Translator, message: string): string {
  return message
    .split('; ')
    .map((part) => {
      const separator = part.indexOf(': ')
      const prefix = separator >= 0 ? part.slice(0, separator + 2) : ''
      const key = separator >= 0 ? part.slice(separator + 2) : part
      return MESSAGE_KEY_SET.has(key) ? `${prefix}${t(key as MessageKey)}` : part
    })
    .join('; ')
}
