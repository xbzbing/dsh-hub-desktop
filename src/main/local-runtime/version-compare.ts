/**
 * 数字感知的版本比较原语。
 *
 * 独立成模块是为了让安装器与运行时决策共用同一实现而不产生循环依赖：
 * `runtime-source` 依赖安装器的版本号模式，安装器反过来需要版本比较。
 *
 * 预发布后缀（`-rc9` / `-rc10` / `-alpha.2`）内的数字段按数值比较，不按字典序，
 * 否则 `rc10` 会被判得比 `rc9` 小。
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
      return compareSuffix(suffixA, suffixB)
    }
  }
  return 0
}

function leadingNumber(segment: string): number {
  const match = /^[0-9]+/.exec(segment)
  return match ? Number(match[0]) : 0
}

/**
 * 预发布后缀比较：拆成交替的「非数字 / 数字」片段，数字片段按数值比、
 * 其余按字典序。这样 `-rc9` < `-rc10`（数值 9 < 10），而 `-alpha` < `-rc`（字典序）。
 */
function compareSuffix(a: string, b: string): number {
  const tokensA = tokenizeSuffix(a)
  const tokensB = tokenizeSuffix(b)
  const len = Math.max(tokensA.length, tokensB.length)
  for (let i = 0; i < len; i += 1) {
    const ta = tokensA[i]
    const tb = tokensB[i]
    // 片段数不同：较短的一方排前（`-rc` < `-rc.1`）
    if (ta === undefined) return -1
    if (tb === undefined) return 1
    if (ta.numeric && tb.numeric) {
      if (ta.value !== tb.value) return (ta.value as number) - (tb.value as number)
    } else if (ta.numeric !== tb.numeric) {
      // 数字片段与文本片段：数字排前（惯例 `1` < `a`），保持确定顺序
      return ta.numeric ? -1 : 1
    } else if (ta.text !== tb.text) {
      return ta.text < tb.text ? -1 : 1
    }
  }
  return 0
}

interface SuffixToken {
  numeric: boolean
  value: number
  text: string
}

/** 把后缀拆成交替的数字/非数字片段（`-rc10` → ['-rc', '10']）。 */
function tokenizeSuffix(suffix: string): SuffixToken[] {
  const tokens: SuffixToken[] = []
  for (const match of suffix.matchAll(/[0-9]+|[^0-9]+/g)) {
    const text = match[0]
    const numeric = /^[0-9]+$/.test(text)
    tokens.push({ numeric, value: numeric ? Number(text) : 0, text })
  }
  return tokens
}
