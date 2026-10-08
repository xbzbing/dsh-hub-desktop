import { hasSwitchModifier, hotkeyDigitIndex } from '@shared/hotkeys'
import { rendererPlatform } from './platform'

/**
 * 切换修饰键 + 数字键 1-9 → 侧栏实例序号(0 起下标);其余按键返回 null。
 * 切换修饰键按平台区分:macOS 为 ⌘(Meta),其余平台(Windows/Linux)为 Alt。
 * 序号映射与主进程的工作区输入转发共用 `hotkeyDigitIndex`,两侧判定一致。
 */
export function instanceSwitchIndex(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'altKey' | 'isComposing'>,
  platform: string = rendererPlatform()
): number | null {
  // 输入法组合期间不接管按键。
  if (event.isComposing) return null
  if (!hasSwitchModifier(platform, { meta: event.metaKey, alt: event.altKey })) return null
  return hotkeyDigitIndex(event.key, event.code)
}
