/**
 * 运行时来源策略：「实例当前（或下次启动）跑的是哪一份 dsh」的唯一判据。
 * 升级对象、版本检查、启动来源与状态回写共用本模块，避免各处判定各自演化。
 */
import type { Transport } from '@shared/contracts'
import type { LocalLauncher } from '@shared/local-launch'
import { planRuntimeSource, type PathRuntime } from './runtime-source'

/** 实例运行时来源；undefined = 尚未启动，来源未知。 */
export type DshRuntimeSource = 'hub' | 'path' | 'external' | undefined

/**
 * 公共空间（~/.dsh）+ 自定义启动器（dush/duush）：启动固定跟随系统默认 dsh，
 * 由 hub 注入 DSH_BIN，不装 hub 副本、不理会实例的固定版本。
 * 隔离空间与默认启动器（dsh）走 planRuntimeSource 的来源决策。
 */
export function followsSystemDsh(
  useDefaultSpace: boolean,
  launcher: LocalLauncher | null
): boolean {
  return useDefaultSpace === true && launcher !== null && launcher !== 'dsh'
}

export interface SystemDshUsageQuery {
  transport: Transport
  useDefaultSpace: boolean
  launcher: LocalLauncher | null
  runtimeSource: DshRuntimeSource
  /**
   * 来源未知（未启动）且默认启动器时，下次启动的来源计划 —— 与启动路径
   * `planRuntimeSource` 同款输入算出；`path` 表示会用系统 dsh。其余情况忽略。
   */
  plannedKind?: 'hub' | 'path' | 'download' | null
}

/**
 * 实例当前（或下次启动）是否运行系统默认 dsh。判定顺序：
 * - 非本机 / 非公共空间：数据不与用户终端共享 → 否
 * - 来源已知：以实际来源为准（PATH 实测 → 是，hub 副本 / 外部接管 → 否）
 * - 来源未知：自定义启动器固定跟随系统 → 是；默认启动器以下次启动计划为准
 *   （计划缺省按「不是系统 dsh」处理，宁可升级 hub 副本也不误报系统 dsh 缺失）
 */
export function usesSystemDsh(query: SystemDshUsageQuery): boolean {
  if (query.transport !== 'local' || query.useDefaultSpace !== true) return false
  if (query.runtimeSource === 'path') return true
  if (query.runtimeSource === 'hub' || query.runtimeSource === 'external') return false
  if (followsSystemDsh(query.useDefaultSpace, query.launcher)) return true
  return query.plannedKind === 'path'
}

export interface SystemDshUsageDeps {
  /** 计划推导用的固定版本，与启动路径 `instance.dshVersion` 同一取值（null = 未固定） */
  desiredVersion: string | null
  /** hub 已安装的版本号列表（启动路径 listInstalled 同款数据源） */
  listInstalledVersions: () => Promise<string[]>
  /** PATH 上的系统 dsh 探测；能力未装配时返回 null */
  probePath: () => Promise<PathRuntime | null>
}

export interface SystemDshUsageDecision {
  usesSystemDsh: boolean
  /** 决策期间的 PATH 探测结果（未探测为 null）；系统分支可直接复用，不重复探测 */
  pathRuntime: PathRuntime | null
}

/**
 * 升级/检查用的完整判定：来源未知且需要计划时，按启动路径同款输入补全计划，
 * 并在结论为「系统 dsh」时顺带完成 PATH 探测供调用方复用。
 */
export async function resolveSystemDshUsage(
  query: SystemDshUsageQuery & SystemDshUsageDeps
): Promise<SystemDshUsageDecision> {
  const base = {
    transport: query.transport,
    useDefaultSpace: query.useDefaultSpace,
    launcher: query.launcher,
    runtimeSource: query.runtimeSource
  }
  if (query.transport !== 'local' || query.useDefaultSpace !== true) {
    return { usesSystemDsh: false, pathRuntime: null }
  }
  if (query.runtimeSource === 'hub' || query.runtimeSource === 'external') {
    return { usesSystemDsh: false, pathRuntime: null }
  }
  // 未启动 + 默认启动器：与启动路径同一决策输入，避免把即将运行的 hub 副本误当系统 dsh。
  if (
    query.runtimeSource === undefined &&
    !followsSystemDsh(query.useDefaultSpace, query.launcher)
  ) {
    const [hubInstalled, pathRuntime] = await Promise.all([
      query.listInstalledVersions(),
      query.probePath()
    ])
    const plannedKind = planRuntimeSource({
      desiredVersion: query.desiredVersion,
      hubInstalled,
      pathRuntime
    }).kind
    return { usesSystemDsh: usesSystemDsh({ ...base, plannedKind }), pathRuntime }
  }
  const pathRuntime = await query.probePath()
  return { usesSystemDsh: usesSystemDsh(base), pathRuntime }
}

/** 外部接管的进程归用户所有：hub 不管理它的运行时。 */
export function isExternalRuntime(source: DshRuntimeSource): boolean {
  return source === 'external'
}

/** 版本只认 hub 自己安装的运行时；PATH 实测与外部接管的版本不归 hub 回写。 */
export function isHubOwnedRuntime(source: DshRuntimeSource): boolean {
  return source !== 'path' && source !== 'external'
}
