/**
 * 「已自动禁用不兼容的插件」提示的确认记录：instanceId → 用户点过「知道了」的 dsh 版本。
 *
 * 确认纯属界面状态（不影响主进程的自动禁用结果，也不改写插件加载清单），因此落在渲染层
 * localStorage：刷新（Cmd+R）与应用重启后同一批自动禁用不再重复提示；dsh 版本再次变更
 * （即下一次自动禁用批次）时版本号不同，会重新提示。
 */
export interface AckStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** localStorage 键：一个实例一条记录，值为已确认的 dsh 版本。 */
const ACK_KEY = 'dshhub-auto-disabled-acked'

/** 读取确认记录；缺失或损坏时视为没有确认过（宁可再提示一次，也不静默吞掉提示）。 */
export function readAutoDisabledAcks(storage: AckStorage): Record<string, string> {
  try {
    const raw = storage.getItem(ACK_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const acks: Record<string, string> = {}
    for (const [instanceId, version] of Object.entries(parsed)) {
      if (typeof version === 'string' && version !== '') acks[instanceId] = version
    }
    return acks
  } catch {
    return {}
  }
}

/** 该实例在该 dsh 版本上的自动禁用提示是否已被确认。 */
export function isAutoDisabledAcked(
  storage: AckStorage,
  instanceId: string,
  dshVersion: string
): boolean {
  return (readAutoDisabledAcks(storage)[instanceId] ?? null) === dshVersion
}

/** 记下确认；同实例的旧版本记录被覆盖（新批次需要重新确认）。 */
export function ackAutoDisabled(storage: AckStorage, instanceId: string, dshVersion: string): void {
  const acks = { ...readAutoDisabledAcks(storage), [instanceId]: dshVersion }
  try {
    storage.setItem(ACK_KEY, JSON.stringify(acks))
  } catch {
    // 存储不可用（配额或禁用）只导致下次仍会提示一次，其它功能不受影响。
  }
}
