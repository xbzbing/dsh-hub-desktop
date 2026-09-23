/**
 * 数字感知的版本比较原语。
 *
 * 独立成模块是为了让安装器与运行时决策共用同一实现而不产生循环依赖：
 * `runtime-source` 依赖安装器的版本号模式，安装器反过来需要版本比较。
 */
export function compareDshVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const segA = pa[i] ?? ''
    const segB = pb[i] ?? ''
    const numA = leadingNumber(segA)
    const numB = leadingNumber(segB)
    if (numA !== numB) return numA - numB
    const suffixA = segA.slice(String(numA).length)
    const suffixB = segB.slice(String(numB).length)
    if (suffixA !== suffixB) {
      // 正式(无后缀)> 预发布(有 rc 等后缀)
      if (suffixA === '') return 1
      if (suffixB === '') return -1
      return suffixA < suffixB ? -1 : 1
    }
  }
  return 0
}

function leadingNumber(segment: string): number {
  const match = /^[0-9]+/.exec(segment)
  return match ? Number(match[0]) : 0
}
