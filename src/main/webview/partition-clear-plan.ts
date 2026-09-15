/**
 * 分区会话清理的「接线计划」（T9 装配层）—— 纯函数,不 import electron。
 *
 * 与 `open-view-plan.ts` 同因:三轮评审反复证明 `src/main/index.ts` 的装配逻辑
 * 没有直接测试,清理链路的回归可以静默通过全套用例。这里把
 * 「实例记录 + 隧道实时端口 → (origin, basePath, 分区名)」单点抽出来。
 *
 * 关键约束(评审 T9-2):**ssh 必须在隧道已停时回落到注册表持久化的 `localPort`** ——
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
    // 与注入侧同一套 basePath 规则(评审 Minor 8)
    basePath: basePathOf(endpoint)
  }
}
