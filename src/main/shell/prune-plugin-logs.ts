/**
 * dsh 插件操作日志清理。
 *
 * dsh 每次执行 `dsh plugin ...` 都会在
 * `<DSH_HOME>/profiles/<profile>/.plugin-manager/logs/` 下 mkdtemp 出一个
 * `operation-XXXXXX` 目录（内含 `pnpm.log`），且自身不做清理。hub 频繁调用
 * `dsh plugin list` 刷新插件状态，这些目录会无上限地堆积。本模块在 hub 启动时
 * 按目录 mtime 清理超过保留期的 `operation-*` 目录，默认保留最近 30 天。
 *
 * 约束：
 * 1. 只删严格以 `operation-` 开头且确为目录的条目；logs 目录里其它文件/目录不碰；
 * 2. 保留期按目录 mtime 与当前时间比较，mtime ≥ cutoff 一律保留；
 * 3. 任一条目失败只经 onError 上报并继续清理其余条目，绝不冒泡进启动流程；
 * 4. profiles / logs 目录不存在等价于无日志，静默跳过（ENOENT 不算错误）。
 */
import { readdir, rm, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InstanceRecord } from '@shared/contracts'
import { instanceHomeDir } from './open-instance-dir'

/** 默认保留天数：早于此的 operation-* 目录会被清理。 */
export const PLUGIN_LOG_MAX_AGE_DAYS = 30

/** dsh 插件操作日志目录名前缀（dsh `mkdtemp` 固定用此前缀）。 */
const OPERATION_PREFIX = 'operation-'

const DAY_MS = 24 * 60 * 60 * 1000

export interface PrunePluginLogsOptions {
  /** 归档保留天数；缺省 PLUGIN_LOG_MAX_AGE_DAYS。 */
  maxAgeDays?: number
  /** 注入时钟（测试）。 */
  now?: () => number
  /** 单条清理失败上报；缺省静默（日志清理失败不应影响任何业务）。 */
  onError?: (error: unknown) => void
}

/** 清理单个 logs 目录下的过期 operation-* 目录。 */
async function pruneLogsDir(
  logsDir: string,
  cutoffMs: number,
  onError: (error: unknown) => void,
  removed: string[]
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(logsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError(error)
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(OPERATION_PREFIX)) continue
    const dir = join(logsDir, entry.name)
    try {
      const info = await stat(dir)
      if (info.mtimeMs >= cutoffMs) continue
      await rm(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch (error) {
      onError(error)
    }
  }
}

/**
 * 清理单个 DSH_HOME 下所有 profile 的过期 operation-* 目录；返回被删目录的绝对路径。
 */
export async function prunePluginOperationLogs(
  homeDir: string,
  options: PrunePluginLogsOptions = {}
): Promise<string[]> {
  const now = options.now ?? (() => Date.now())
  const maxAgeDays = options.maxAgeDays ?? PLUGIN_LOG_MAX_AGE_DAYS
  const onError = options.onError ?? (() => undefined)
  const cutoffMs = now() - maxAgeDays * DAY_MS
  const profilesDir = join(homeDir, 'profiles')
  const removed: string[] = []
  let profiles: Dirent[]
  try {
    profiles = await readdir(profilesDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError(error)
    return removed
  }
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue
    await pruneLogsDir(join(profilesDir, profile.name, '.plugin-manager', 'logs'), cutoffMs, onError, removed)
  }
  return removed
}

/** hub 管理的本机实例去重后的 DSH_HOME 集合（只有本机实例才有本地日志目录）。 */
export function managedDshHomes(
  dataRoot: string,
  records: readonly InstanceRecord[],
  home: string = homedir()
): string[] {
  const homes = new Set<string>()
  for (const record of records) {
    if (record.transport !== 'local') continue
    homes.add(instanceHomeDir({ dataRoot, homeDir: () => home }, record))
  }
  return [...homes]
}

export interface PruneInstancesParams {
  dataRoot: string
  records: readonly InstanceRecord[]
  /** 用户主目录（测试注入）；缺省 os.homedir。 */
  home?: string
  options?: PrunePluginLogsOptions
}

/**
 * 清理 hub 所有本机实例 DSH_HOME 下的过期 operation-* 目录；返回被删目录的绝对路径。
 */
export async function prunePluginLogsForInstances(params: PruneInstancesParams): Promise<string[]> {
  const removed: string[] = []
  for (const home of managedDshHomes(params.dataRoot, params.records, params.home)) {
    removed.push(...(await prunePluginOperationLogs(home, params.options)))
  }
  return removed
}
