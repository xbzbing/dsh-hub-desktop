/**
 *
 * 「实例记录 + 隧道实时端口 → (origin, basePath, 分区名)」单点抽出来。
 *
 * 删除实例的顺序是「先停隧道 → 再清分区 Cookie」,此时实时端口已经取不到,
 * 若不回落,端点解析返回 null,清理会静默 no-op,留下一个仍然有效的网关会话。
 */
import type { InstanceRecord } from '@shared/contracts'
import { authEndpointOf } from '../transport/endpoint-resolver'
import { basePathOf } from './open-view-plan'
import { originOf } from './session-cookie'

export interface PartitionClearPlan {
  /** 实例分区名(`persist:inst-<id>`) */
  partition: string
  origin: string
  basePath: string
}

/**
 * 计算清理某实例分区会话所需的信息。
 * @param liveTunnelPort 隧道实时本地端口(隧道已停时为 undefined)
 * @returns null 表示「无需/无法清理」(local 实例、无端点、origin 不可解析)
 */
export function planPartitionClear(
  record: InstanceRecord | null,
  liveTunnelPort: number | undefined
): PartitionClearPlan | null {
  if (!record) return null
  // local 实例走 dsh 自带 BrowserAuth,没有网关会话可清
  if (record.transport === 'local') return null

  const tunnelPort =
    record.transport === 'ssh' ? (liveTunnelPort ?? record.localPort ?? undefined) : undefined
  const endpoint = authEndpointOf(record, tunnelPort)
  if (!endpoint) return null

  const origin = originOf(endpoint)
  if (!origin) return null

  return {
    partition: `persist:inst-${record.id}`,
    origin,
    basePath: basePathOf(endpoint)
  }
}
