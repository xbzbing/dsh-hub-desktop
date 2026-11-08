/**
 * 安全检查结论的放行口径——主进程闸门与渲染层按钮共用，避免两边判断不一致。
 *
 * `blocked` 有两个来源，处理方式不同：
 * - 结构性失败（哈希不符、包名/版本与元数据不一致、路径穿越）来自对包体本身的
 *   校验，说明取回的不是请求的那个包；用户确认改变不了这个事实，不提供覆盖入口。
 * - 启发式规则（内容特征、安装脚本、名称/声誉、漏洞标记）会误报，例如注释里提到
 *   `.npmrc`、文档里写 `fetch(`；这类结论允许用户核对证据后仍要安装。
 */
import type { PluginSecurityCheckId, PluginSecurityReport } from './contracts'

/** 判定包体属于「取回的包与请求不一致」的检查项。 */
const STRUCTURAL_CHECK_IDS = new Set<PluginSecurityCheckId>(['integrity'])

type ReportLike = Pick<PluginSecurityReport, 'verdict' | 'checks'>

/** 报告是否只能阻止安装：结构性失败没有「仍要安装」的覆盖入口。 */
export function securityHardBlocked(report: ReportLike | null): boolean {
  if (report === null || report.verdict !== 'blocked') return false
  return report.checks.some(
    (check) =>
      STRUCTURAL_CHECK_IDS.has(check.id) && (check.level === 'blocked' || check.level === 'danger')
  )
}

/** 需要用户显式确认（主按钮改为「仍要安装」）才能提交安装。 */
export function securityNeedsAcknowledgement(report: ReportLike | null, failed = false): boolean {
  if (failed) return true
  if (report === null) return false
  if (report.verdict === 'warn' || report.verdict === 'unavailable') return true
  return report.verdict === 'blocked' && !securityHardBlocked(report)
}
