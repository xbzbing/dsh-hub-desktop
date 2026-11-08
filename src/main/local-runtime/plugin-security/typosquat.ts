/**
 * 名称/scope 仿冒检查：与已安装插件、官方 scope 做编辑距离比对。
 *
 * 只提示、不自动改 spec；目标是拦住「打错一个字就装到仿冒包」的最常见情况。
 */
import type { PluginSecurityFinding } from '@shared/contracts'

export interface NameCheckResult {
  level: 'pass' | 'warn'
  code: string
  params: Record<string, string | number | boolean | null>
  findings: PluginSecurityFinding[]
}

function splitName(name: string): { scope: string | null; base: string } {
  const normalized = name.toLowerCase()
  const slash = normalized.indexOf('/')
  if (normalized.startsWith('@') && slash > 0) {
    return { scope: normalized.slice(0, slash), base: normalized.slice(slash + 1) }
  }
  return { scope: null, base: normalized }
}

/** 编辑距离；超过 max 时提前返回 max + 1。 */
function distance(left: string, right: string, max: number): number {
  if (Math.abs(left.length - right.length) > max) return max + 1
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      const value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost
      )
      current[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return max + 1
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length] ?? max + 1
}

function thresholdFor(base: string): number {
  return base.length >= 12 ? 2 : 1
}

function finding(code: string, match: string): PluginSecurityFinding {
  return {
    code,
    level: 'warn',
    count: 1,
    evidence: [{ file: null, line: null, match }],
    refs: []
  }
}

/**
 * `name` 为待安装包名；`installedNames` 为同一 profile 已装包名。
 * 返回 null 表示没有足够上下文（如全新实例），调用方按 pass 处理。
 */
export function checkPluginName(name: string, installedNames: readonly string[]): NameCheckResult {
  const target = splitName(name)
  const others = installedNames
    .filter((item) => item.toLowerCase() !== name.toLowerCase())
    .map((item) => ({ raw: item, ...splitName(item) }))

  // 官方 scope 正常；非官方但含 deepseek 的名称按「模仿官方」提示。
  if (target.scope !== '@deepseek-ai' && /deepseek/i.test(target.base)) {
    return {
      level: 'warn',
      code: 'name.official-impersonation',
      params: { name },
      findings: [finding('name.official-impersonation', name)]
    }
  }

  const similar = others.find(
    (item) =>
      distance(target.base, item.base, thresholdFor(target.base)) <= thresholdFor(target.base)
  )
  if (similar !== undefined) {
    return {
      level: 'warn',
      code: 'name.similar-installed',
      params: { name, similar: similar.raw },
      findings: [finding('name.similar-installed', similar.raw)]
    }
  }

  // 同 scope 是同一发布者的正常共存（升级、同作者的第二个插件），不算仿冒；
  // 只有「相似但不同」的 scope 才可能是抢注的近似域。
  const targetScope = target.scope
  if (targetScope !== null) {
    const similarScope = others.find(
      (item) =>
        item.scope !== null &&
        item.scope !== targetScope &&
        distance(targetScope, item.scope, 1) <= 1
    )
    if (similarScope !== undefined && similarScope.scope !== null) {
      return {
        level: 'warn',
        code: 'name.scope-similar',
        params: { name, similarScope: similarScope.scope },
        findings: [finding('name.scope-similar', similarScope.scope)]
      }
    }
  }

  return { level: 'pass', code: 'name.ok', params: { name }, findings: [] }
}
