/**
 * 注册表 schema 迁移器。
 *
 * v1→v2：v2 收紧了两处**持久化字段**的校验，历史数据可能带有 v1 下合法、v2 下会被拒的值：
 * - SSH `host`：v1 接受任意方括号内容（`[plainhost]`），v2 只允许方括号包裹 IPv6 字面量。
 *   迁移把方括号剥掉（`[plainhost]` → `plainhost`）；已是合法 IPv6 方括号形态（`[::1]`）保持不变。
 * - `dshVersion`：v1 只限长度，v2 要求匹配 `DSH_VERSION_PATTERN`。含空格等非法字符的历史值置 null
 *   （相当于「未固定版本」，下次启动按最新解析），而不是让整表因单条不合法被隔离。
 *
 * 迁移是逐字段归一化的纯函数：只改会被 v2 拒绝的字段，其余原样透传；解析失败一律安全回退，
 * 绝不抛异常（抛出会让整个 load 走隔离路径，正是要避免的数据丢失）。
 */
import { DSH_VERSION_PATTERN, type RegistryMigration } from '@shared/contracts'

/** 方括号包裹的内容是否为合法 IPv6 字面量（仅十六进制 / 冒号 / 点分尾）。 */
function isBracketedIpv6(host: string): boolean {
  return /^\[[0-9a-fA-F:.]+\]$/.test(host)
}

/** v1 的方括号主机归一化：非 IPv6 字面量的方括号剥括号；合法 IPv6 方括号保持。 */
function normalizeHost(host: string): string {
  if (!host.startsWith('[') && !host.endsWith(']')) return host
  if (isBracketedIpv6(host)) return host
  return host.replace(/^\[/, '').replace(/\]$/, '')
}

/** 逐字段归一化单条实例记录（只碰 v2 会拒绝的字段）。 */
function migrateRecordV1toV2(record: unknown): unknown {
  if (typeof record !== 'object' || record === null) return record
  const next = { ...(record as Record<string, unknown>) }
  if (typeof next.host === 'string') {
    next.host = normalizeHost(next.host)
  }
  // dshVersion 仅 local 实例有；非法（含空格等）→ null（未固定，下次按最新解析）。
  if (typeof next.dshVersion === 'string' && !DSH_VERSION_PATTERN.test(next.dshVersion.trim())) {
    next.dshVersion = null
  }
  return next
}

/** v1 → v2：归一化历史 host 与 dshVersion，避免整表因单条不合法被隔离。 */
export const migrateRegistryV1toV2: RegistryMigration = (file) => {
  if (typeof file !== 'object' || file === null) return file
  const source = file as { instances?: unknown }
  const instances = Array.isArray(source.instances)
    ? source.instances.map(migrateRecordV1toV2)
    : source.instances
  return { ...source, instances, schemaVersion: 2 }
}

/** 生产迁移链：from-version → 升级一版。 */
export const REGISTRY_MIGRATIONS: Record<number, RegistryMigration> = {
  1: migrateRegistryV1toV2
}
