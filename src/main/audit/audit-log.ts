/**
 *
 * `<dataRoot>/audit/audit.log`(JSONL),**按本地日历日轮转**为
 * `audit.log.<YYYY-MM-DD>`,归档超过 90 天删除 —— 命名与保留策略镜像
 * `dsh-auth-gateway` 的 `lib/audit-log.js`(便于两边对照 grep)。
 *
 * 1. **记录由白名单字段显式构造**,不做对象展开 —— 调用方多传的字段(哪怕误传
 *    密码)不会进入日志;`result` 截断到 64 字符;
 * 2. 只 append,不改写历史;`ts` 为 UTC ISO-8601(归档文件名用本地日,跨零点可能
 *    与 ISO 日期不同,与网关行为一致);
 * 3. **写失败绝不冒泡进业务流**:失败经 `onError` 上报,审计不可用不该让登录失败;
 * 4. 清理只删**严格匹配** `audit.log.<YYYY-MM-DD>` 的文件,目录里其它文件一律不碰。
 */
import { createRotatingLog, localDay } from '../rotating-log'

/** 当日活动文件名 */
export const AUDIT_LOG_NAME = 'audit.log'

export const AUDIT_MAX_AGE_DAYS = 90

/** 单条 `result` 的最大长度(防御性截断,避免意外写入长文本) */
export const MAX_RESULT_LENGTH = 64

export const AUDIT_EVENTS = [
  'connect',
  'disconnect',
  'ssh-exit',
  'ssh-reconnect',
  'login-success',
  'login-failed',
  'rate-limited',
  'lockout',
  'session-revoked',
  'cookie-cleared',
  'vault-write',
  'vault-clear',
  'vault-unavailable'
] as const

export type AuditEvent = (typeof AUDIT_EVENTS)[number]

/** 调用方传入的审计入参:只有这三个白名单字段 */
export interface AuditEntry {
  instanceId?: string | null
  event: AuditEvent
  /** 结果码(如 `ok` / `invalid-credentials` / `otp-required`);会被截断 */
  result?: string
}

/** 实际落盘的一条记录 */
export interface AuditRecord {
  ts: string
  instanceId: string | null
  event: AuditEvent
  result: string
}

export interface AuditLogOptions {
  /** 审计目录(通常 `<userData>/audit`) */
  dir: string
  /** 注入时钟(测试) */
  now?: () => number
  /** 失败上报(默认 console.error);审计不可用不应影响业务 */
  onError?: (error: unknown) => void
  /** 归档保留天数 */
  maxAgeDays?: number
}

export interface AuditLog {
  /** 追加一条审计记录;永不抛(失败经 onError 上报) */
  write(entry: AuditEntry): Promise<void>
  /** 删除过期归档;返回被删除的文件名 */
  prune(): Promise<string[]>
  /** 当日活动文件路径 */
  logPath(): string
  /** 已写入的记录数(测试/自检用) */
  count(): number
}

/**
 * 记录的白名单投影:显式逐字段构造(不 spread),并截断 `result`。
 * 这是「审计不含凭据」的结构性保证 —— 调用方无法把额外字段带进日志。
 */
export function projectAuditRecord(entry: AuditEntry, isoNow: string): AuditRecord {
  const result = (entry.result ?? 'ok').slice(0, MAX_RESULT_LENGTH)
  return {
    ts: isoNow,
    instanceId: entry.instanceId ?? null,
    event: entry.event,
    result
  }
}

/** 从活动文件的最后一条 JSONL 记录取归属日;无法解析时返回 null。 */
function dayOfRecordLine(lastLine: string): string | null {
  try {
    const record = JSON.parse(lastLine) as { ts?: unknown }
    if (typeof record.ts !== 'string') return null
    const date = new Date(record.ts)
    return Number.isNaN(date.getTime()) ? null : localDay(date)
  } catch {
    return null
  }
}

export function createAuditLog(options: AuditLogOptions): AuditLog {
  const onError =
    options.onError ?? ((error: unknown) => console.error('[audit] 写入失败：', error))
  const log = createRotatingLog({
    dir: options.dir,
    fileName: AUDIT_LOG_NAME,
    now: options.now ?? (() => Date.now()),
    maxAgeDays: options.maxAgeDays ?? AUDIT_MAX_AGE_DAYS,
    onError,
    dayOfLastLine: dayOfRecordLine
  })

  let written = 0

  return {
    logPath: log.logPath,
    count: () => written,

    async write(entry) {
      const record = projectAuditRecord(
        entry,
        new Date(options.now?.() ?? Date.now()).toISOString()
      )
      try {
        await log.appendLine(JSON.stringify(record))
        written += 1
      } catch (error) {
        onError(error)
      }
    },

    prune: log.prune
  }
}
