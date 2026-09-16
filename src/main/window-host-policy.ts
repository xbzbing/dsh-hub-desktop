/**
 * 实例窗口导航策略（T3 加固;T15 前的用户反馈 #4 修正）—— 纯函数，不 import electron（全局规则 5）。
 *
 * 设计依据：实现计划 §6.6「拦截外跳」—— 实例窗口只允许在本实例服务上导航。
 * `setWindowOpenHandler` 只挡住弹窗，顶层 `<a href>` / form 提交必须在这里拦截，
 * 否则 `persist:inst-<id>` 分区（网关 HttpOnly Cookie 所在）能被一条链接带到任意外部 origin。
 *
 * 放行面（两选一）:
 * ① **同 origin**(http 远程实例的全部页面 —— 网关登录页 / OTP / onboarding / 工作区
 *    都在实例自身服务上;用户反馈 #4:登录页 form 提交被回环判定拦截 → 「输入密码无反应」);
 * ② **回环主机 + 同端口**(local/ssh 实例;localhost/[::1]/127.1 等回环别名视为同一服务,
 *    跨端口拒绝防串到其他实例或本机其他服务)。
 */
import { isLoopbackHost } from '@shared/endpoint'

export function isAllowedInstanceNavigation(targetUrl: string, originUrl: string): boolean {
  let target: URL
  let origin: URL
  try {
    target = new URL(targetUrl)
    origin = new URL(originUrl)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
  // ① 同 origin 放行(远程实例的登录/OTP/onboarding/工作区导航)
  if (target.origin === origin.origin) return true
  // ② 回环同端口放行(别名等价;跨端口拒绝)
  if (!isLoopbackHost(target.hostname)) return false
  return target.port === origin.port
}
