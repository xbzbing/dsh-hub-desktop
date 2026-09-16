
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
