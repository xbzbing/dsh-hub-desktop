import { hotkeyDigitIndex } from '@shared/hotkeys'
import type { WorkspaceHotkeyEvent } from '@shared/contracts'

/** `before-input-event` 的按键输入(只取过滤所需字段)。 */
export interface WorkspaceKeyInput {
  type: string
  key: string
  code: string
  meta: boolean
  control: boolean
  isComposing: boolean
}

/**
 * 工作区输入 → hub 快捷键转发的白名单过滤。
 *
 * 只放行会话切换所需的两类输入:⌘/Ctrl 键本身(侧栏序号的按住态)
 * 与按住它们时的数字键 1-9。其余输入返回 null,既不转发也不拦截,
 * 交回工作区页面按原样处理。
 */
export function toWorkspaceHotkey(input: WorkspaceKeyInput): WorkspaceHotkeyEvent | null {
  if (input.isComposing) return null
  if (input.type !== 'keyDown' && input.type !== 'keyUp') return null
  if (input.key === 'Meta' || input.key === 'Control') {
    return {
      phase: input.type === 'keyDown' ? 'down' : 'up',
      key: input.key,
      code: input.code,
      meta: input.meta,
      ctrl: input.control
    }
  }
  if (input.type === 'keyDown' && (input.meta || input.control) && hotkeyDigitIndex(input.key, input.code) !== null) {
    return {
      phase: 'down',
      key: input.key,
      code: input.code,
      meta: input.meta,
      ctrl: input.control
    }
  }
  return null
}
