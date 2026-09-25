import { join } from 'node:path'
import { createAuditLog } from './audit/audit-log'
import type { AuditEntry, AuditLog } from './audit/audit-log'

/**
 * 放在主进程而不是渲染层:即使没有窗口(后台启动)审计也要完整。
 */
let audit: AuditLog | null = null

export function auditWrite(entry: AuditEntry): void {
  void audit?.write(entry).catch(() => undefined)
}

export interface AuditControlDeps {
  /** 数据根目录（审计目录为 `<dataRoot>/audit`） */
  dataRoot: string
  /** safeStorage 是否可用；false 时必须记录降级 */
  safeStorageAvailable: boolean
  /** 当前 safeStorage 后端枚举（降级留痕用） */
  safeStorageBackend: () => string | undefined
}

/**
 * 审计日志初始化与启动时的归档清理。
 */
export function createAudit(deps: AuditControlDeps): AuditLog {
  audit = createAuditLog({ dir: join(deps.dataRoot, 'audit') })
  if (!deps.safeStorageAvailable) {
    // 降级必须留痕,且只记枚举不记内容;后端枚举用于排查系统钥匙串选择失败
    const backend = deps.safeStorageBackend()
    auditWrite({
      event: 'vault-unavailable',
      result: backend ? `degraded:${backend}` : 'degraded'
    })
  }
  // 启动时清理过期归档(不阻塞启动)
  void audit.prune().catch((error: unknown) => console.error('[main] 审计归档清理失败：', error))
  return audit
}
