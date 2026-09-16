/**
 * 运行状态事件 → 实例记录回写补丁(纯函数,不 import electron)。
 *
 * 实机反馈两轮把它从 `main/index.ts` 的内联逻辑里提出来:
 * - #2:只有 hub 来源的运行时才回写 version —— PATH 来源运行的是用户本机安装,
 *   回写会把未固定实例钉死在探测当天的版本上(用户升级后反被拖回旧版);
 * - 实机反馈 2026-09-16:external(接管用户手工常驻的 dsh web)同理,
 *   版本与端口都不回写 —— 端口的语义是「hub 下次启动优先用哪个端口」,
 *   把用户自己的端口写进配置会让 hub 下次启动去抢它。
 *
 * 提取的直接动因是一个真实缺陷:`PatchInstanceSchema` 拒绝**空补丁**
 * (`补丁不能为空`),而 external 事件恰好只剩空补丁 → 每次接管/重复接管都
 * 在日志里刷一条 `回写实例运行信息失败`。决策变成纯函数后可穷举测试,
 * 「空补丁不落盘」成为有守卫的契约而不是巧合。
 */
import type { InstanceStatusEvent, PatchInstanceInput, Transport } from '@shared/contracts'

/** 回写所需的字段子集(便于测试直接构造,不必凑齐整个事件) */
export interface RuntimeWritebackInput {
  port?: number | undefined
  version?: number | string | undefined
  runtimeSource?: InstanceStatusEvent['runtimeSource']
}

/**
 * 计算需要持久化的补丁;返回空对象表示**无需回写**(调用方必须据此跳过 update ——
 * store 会拒绝空补丁)。
 */
export function runtimeWritebackPatch(
  event: RuntimeWritebackInput,
  transport: Transport | undefined
): PatchInstanceInput {
  const patch: PatchInstanceInput = {}
  const source = event.runtimeSource

  // 端口:外部接管的端口属于用户进程,不回写(见文件头注释)
  if (event.port !== undefined && source !== 'external') {
    if (transport === 'ssh') patch.localPort = event.port
    else patch.port = event.port
  }

  // 版本:只认 hub 自己安装的运行时;空串视为「未知」同样不回写
  if (
    typeof event.version === 'string' &&
    event.version !== '' &&
    source !== 'path' &&
    source !== 'external'
  ) {
    patch.dshVersion = event.version
  }

  return patch
}

/** 补丁是否为空(调用方守卫:空则跳过 store.update,否则 store 抛 invalid-input) */
export function isEmptyPatch(patch: PatchInstanceInput): boolean {
  return Object.keys(patch).length === 0
}
