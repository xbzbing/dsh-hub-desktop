/**
 * 实例切换数字键的统一映射。
 *
 * 主进程(工作区输入白名单转发)与渲染层(快捷键处理)共用本映射,
 * 保证两侧对「哪个键对应第几个实例」的判定一致。
 */

/**
 * 数字键 1-9 → 0 起下标;非切换键返回 null。
 * 优先按 `code` 判定物理键位(主键盘与小键盘均接受);部分输入路径只带 `key`,按单字符数字兜底。
 */
export function hotkeyDigitIndex(key: string, code: string): number | null {
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code)
  if (digit) return Number(digit[1]) - 1
  if (/^[1-9]$/.test(key)) return Number(key) - 1
  return null
}

/**
 * 实例切换的修饰键按平台区分:macOS 用 ⌘(Meta),其余平台(Windows/Linux)用 Alt
 * ——Windows 上 ⌘ 对应 Win 键不便使用,改用 Alt。主进程转发白名单与渲染层按键处理
 * 共用本判定,两侧对「哪个修饰键触发切换」保持一致。
 */
export function switchModifierKey(platform: string): 'Meta' | 'Alt' {
  return platform === 'darwin' ? 'Meta' : 'Alt'
}

/** 该瞬间的修饰键状态是否满足当前平台的「切换修饰键被按住」。 */
export function hasSwitchModifier(
  platform: string,
  mods: { meta: boolean; alt: boolean }
): boolean {
  return platform === 'darwin' ? mods.meta : mods.alt
}

/**
 * 每个平台可能出现的修饰键名。按住这些键只是组合的前缀，不构成「与其他键的组合」；
 * 主进程的输入转发与渲染层的按键处理共用本判定，两侧对「什么算组合键」保持一致。
 */
const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'Fn',
  'FnLock',
  'AltGraph'
])

/** 该键名是否为修饰键本身。 */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}
