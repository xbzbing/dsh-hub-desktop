import { hotkeyDigitIndex } from '@shared/hotkeys'

/**
 * ⌘/Ctrl + 数字 1-9 → 侧栏实例序号(0 起下标);其余按键返回 null。
 * 序号映射与主进程的工作区输入转发共用 `hotkeyDigitIndex`,两侧判定一致。
 */
export function instanceSwitchIndex(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'isComposing'>
): number | null {
  // 输入法组合期间不接管按键。
  if (event.isComposing) return null
  if (!event.metaKey && !event.ctrlKey) return null
  return hotkeyDigitIndex(event.key, event.code)
}
