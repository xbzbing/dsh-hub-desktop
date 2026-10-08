import { hasSwitchModifier, hotkeyDigitIndex, switchModifierKey } from '@shared/hotkeys'
import type { WorkspaceHotkeyEvent } from '@shared/contracts'

/** `before-input-event` 的按键输入(只取过滤所需字段)。 */
export interface WorkspaceKeyInput {
  type: string
  key: string
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  isComposing: boolean
}

/**
 * 工作区输入 → hub 快捷键转发的白名单过滤。
 *
 * 只放行会话切换所需的两类输入:当前平台的切换修饰键本身(macOS 为 ⌘/Meta,
 * 其余平台为 Alt)的按住态,与按住它时的数字键 1-9。其余输入返回 null,
 * 既不转发也不拦截,交回工作区页面按原样处理。
 */
export function toWorkspaceHotkey(
  input: WorkspaceKeyInput,
  platform: string
): WorkspaceHotkeyEvent | null {
  if (input.isComposing) return null
  if (input.type !== 'keyDown' && input.type !== 'keyUp') return null
  const forward = (phase: 'down' | 'up'): WorkspaceHotkeyEvent => ({
    phase,
    key: input.key,
    code: input.code,
    meta: input.meta,
    ctrl: input.control,
    alt: input.alt
  })
  if (input.key === switchModifierKey(platform)) {
    return forward(input.type === 'keyDown' ? 'down' : 'up')
  }
  if (
    input.type === 'keyDown' &&
    hasSwitchModifier(platform, { meta: input.meta, alt: input.alt }) &&
    hotkeyDigitIndex(input.key, input.code) !== null
  ) {
    return forward('down')
  }
  return null
}
