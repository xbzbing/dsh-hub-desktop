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
