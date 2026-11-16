import {
  hasSwitchModifier,
  hotkeyDigitIndex,
  isModifierKey,
  switchModifierKey
} from '@shared/hotkeys'
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
 * 放行会话切换所需的两类输入:当前平台的切换修饰键本身(macOS 为 ⌘/Meta,
 * 其余平台为 Alt)的按住态,与按住它时的数字键 1-9。按住切换修饰键又按了
 * 其他键(⌘W、⌘N 等组合)时只发出 `cancel`,让侧栏序号提示让位;按键本身
 * 既不转发也不拦截,交回工作区页面按原样处理。其余输入返回 null。
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
  if (input.type !== 'keyDown') return null
  if (!hasSwitchModifier(platform, { meta: input.meta, alt: input.alt })) return null
  if (hotkeyDigitIndex(input.key, input.code) !== null) return forward('down')
  // 组合键里的修饰键本身(如 ⌘+Shift+1)不取消提示,序号仍会按 0.5 秒后显示。
  if (isModifierKey(input.key)) return null
  return { phase: 'cancel' }
}
