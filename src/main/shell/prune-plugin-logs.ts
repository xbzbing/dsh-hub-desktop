/**
 * dsh 插件操作日志归并与清理。
 *
 * dsh 的 plugin-manager 每执行一次 pnpm 操作（安装/启用/禁用/卸载）都会在
 * `<DSH_HOME>/profiles/<profile>/.plugin-manager/logs/` 下 `mkdtemp` 出一个
 * `operation-XXXXXX` 目录（内含 `pnpm.log`），且自身从不清理，这些目录会无上限堆积。
 * dsh 侧无法改成单文件，故由 hub 事后归并：把**已结束**的 operation 目录里**非空**的
 * `pnpm.log` 追加进一个按本地日历日滚动的合并文件 `plugin-operations.<YYYY-MM-DD>.log`，
 * 然后删掉原目录；合并文件按保留期（默认 30 天）清理。
 *
 * 约束与安全：
 * 1. 只处理 `mtime` 早于沉降窗口（settleMs，默认 5 分钟）的 operation 目录：太新的可能是
 *    dsh 正在进行、并作为并发协调记录在用的操作，绝不触碰，否则破坏 dsh 的「前序操作仍在跑」判断；
 * 2. 超过保留期的 operation 目录直接删除（归并了也会被保留期裁掉）；
 * 3. 空的 `pnpm.log`（成功操作无输出，占绝大多数）不写合并文件，目录直接删除；
 * 4. 只删严格 `operation-` 前缀的目录与严格命名的 `plugin-operations.<day>.log` 文件，
 *    logs 目录里其它内容一律不碰；
 * 5. 任一条目失败只经 onError 上报并继续，绝不冒泡进启动流程；
 * 6. profiles / logs 目录不存在等价于无日志，静默跳过（ENOENT 不算错误）。
 */
import { appendFile, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InstanceRecord } from '@shared/contracts'
import { instanceHomeDir } from './open-instance-dir'

/** 合并文件默认保留天数：早于此的按天合并文件（及 operation 目录）会被清理。 */
export const PLUGIN_LOG_MAX_AGE_DAYS = 30

/** 沉降窗口：mtime 比当前时间近于此的 operation 目录跳过，避免碰 dsh 正在进行的操作。 */
export const PLUGIN_LOG_SETTLE_MS = 5 * 60 * 1000

/** dsh 插件操作日志目录名前缀（dsh `mkdtemp` 固定用此前缀）。 */
const OPERATION_PREFIX = 'operation-'

/** 按天合并文件名；只删严格匹配此形态的文件。 */
const DAY_FILE_PATTERN = /^plugin-operations\.(\d{4}-\d{2}-\d{2})\.log$/

const DAY_MS = 24 * 60 * 60 * 1000

export interface ConsolidatePluginLogsOptions {
  /** 合并文件保留天数；缺省 PLUGIN_LOG_MAX_AGE_DAYS。 */
  maxAgeDays?: number
  /** 沉降窗口毫秒；缺省 PLUGIN_LOG_SETTLE_MS。 */
  settleMs?: number
  /** 注入时钟（测试）。 */
  now?: () => number
  /** 单条失败上报；缺省静默（日志维护失败不应影响任何业务）。 */
  onError?: (error: unknown) => void
}

export interface ConsolidateSummary {
  /** 有非空内容、已归并进按天文件的 operation 目录绝对路径。 */
  merged: string[]
  /** 已删除的 operation 目录绝对路径（含已归并与空目录、及超保留期目录）。 */
  removed: string[]
  /** 按保留期删除的按天合并文件绝对路径。 */
  prunedDayFiles: string[]
}

/** 本地日历日 `YYYY-MM-DD`（与 main-log / audit-log 一致，便于对照）。 */
function localDay(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 从合并文件名解析归属日；形状合法但日期不存在（如 2026-13-45）返回 null。 */
function dayFileStamp(name: string): string | null {
  const stamp = DAY_FILE_PATTERN.exec(name)?.[1]
  if (!stamp) return null
  const [year, month, day] = stamp.split('-').map(Number) as [number, number, number]
  return localDay(new Date(year, month - 1, day)) === stamp ? stamp : null
}

interface Cutoffs {
  /** operation 目录 mtime < 此（毫秒）→ 超保留期，直接删除。 */
  retentionCutoffMs: number
  /** 按天合并文件归属日 < 此（本地日）→ 删除。 */
  retentionCutoffDay: string
  /** operation 目录 mtime > 此（毫秒）→ 太新，跳过。 */
  settleCutoffMs: number
}

/** 归并并清理单个 logs 目录。 */
async function consolidateLogsDir(
  logsDir: string,
  cutoffs: Cutoffs,
  onError: (error: unknown) => void,
  summary: ConsolidateSummary
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(logsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError(error)
    return
  }
  for (const entry of entries) {
    const name = entry.name
    // 按天合并文件的保留期清理（只认严格命名）。
    if (entry.isFile()) {
      const stamp = dayFileStamp(name)
      if (stamp && stamp < cutoffs.retentionCutoffDay) {
        try {
          await unlink(join(logsDir, name))
          summary.prunedDayFiles.push(join(logsDir, name))
        } catch (error) {
          onError(error)
        }
      }
      continue
    }
    if (!entry.isDirectory() || !name.startsWith(OPERATION_PREFIX)) continue
    const dir = join(logsDir, name)
    try {
      const info = await stat(dir)
      // 太新：可能是 dsh 正在进行的操作（并发协调记录），不碰。
      if (info.mtimeMs > cutoffs.settleCutoffMs) continue
      // 超保留期：直接删，不必归并（归并了也会被保留期裁掉）。
      if (info.mtimeMs < cutoffs.retentionCutoffMs) {
        await rm(dir, { recursive: true, force: true })
        summary.removed.push(dir)
        continue
      }
      const content = await readFile(join(dir, 'pnpm.log'), 'utf8').catch(() => '')
      if (content.trim() !== '') {
        const day = localDay(new Date(info.mtimeMs))
        const dayFile = join(logsDir, `plugin-operations.${day}.log`)
        const body = content.endsWith('\n') ? content : `${content}\n`
        const header = `===== ${name} @ ${new Date(info.mtimeMs).toISOString()} =====\n`
        await appendFile(dayFile, header + body, { mode: 0o600 })
        summary.merged.push(dir)
      }
      await rm(dir, { recursive: true, force: true })
      summary.removed.push(dir)
    } catch (error) {
      onError(error)
    }
  }
}

/** 归并并清理单个 DSH_HOME 下所有 profile 的 operation 日志。 */
export async function consolidatePluginOperationLogs(
  homeDir: string,
  options: ConsolidatePluginLogsOptions = {}
): Promise<ConsolidateSummary> {
  const now = (options.now ?? (() => Date.now()))()
  const maxAgeDays = options.maxAgeDays ?? PLUGIN_LOG_MAX_AGE_DAYS
  const settleMs = options.settleMs ?? PLUGIN_LOG_SETTLE_MS
  const onError = options.onError ?? (() => undefined)
  const cutoffs: Cutoffs = {
    retentionCutoffMs: now - maxAgeDays * DAY_MS,
    retentionCutoffDay: localDay(new Date(now - maxAgeDays * DAY_MS)),
    settleCutoffMs: now - settleMs
  }
  const summary: ConsolidateSummary = { merged: [], removed: [], prunedDayFiles: [] }
  const profilesDir = join(homeDir, 'profiles')
  let profiles: Dirent[]
  try {
    profiles = await readdir(profilesDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError(error)
    return summary
  }
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue
    await consolidateLogsDir(
      join(profilesDir, profile.name, '.plugin-manager', 'logs'),
      cutoffs,
      onError,
      summary
    )
  }
  return summary
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

export interface ConsolidateInstancesParams {
  dataRoot: string
  records: readonly InstanceRecord[]
  /** 用户主目录（测试注入）；缺省 os.homedir。 */
  home?: string
  options?: ConsolidatePluginLogsOptions
}

/** 归并并清理 hub 所有本机实例 DSH_HOME 下的 operation 日志；汇总各 home 的处理结果。 */
export async function consolidatePluginLogsForInstances(
  params: ConsolidateInstancesParams
): Promise<ConsolidateSummary> {
  const total: ConsolidateSummary = { merged: [], removed: [], prunedDayFiles: [] }
  for (const home of managedDshHomes(params.dataRoot, params.records, params.home)) {
    const summary = await consolidatePluginOperationLogs(home, params.options)
    total.merged.push(...summary.merged)
    total.removed.push(...summary.removed)
    total.prunedDayFiles.push(...summary.prunedDayFiles)
  }
  return total
}
