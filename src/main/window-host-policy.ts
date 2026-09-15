/**
 * 实例窗口导航策略（T3 加固）—— 纯函数，不 import electron（全局规则 5）。
 *
 * 设计依据：实现计划 §6.6「拦截外跳」—— 实例窗口只允许在本实例服务上导航
 * （http(s) + 回环主机 + 与初始 URL 同端口）。`setWindowOpenHandler` 只挡住弹窗，
 * 顶层 `<a href>` 导航必须在这里拦截，否则 `persist:inst-<id>` 分区（后续 T6/T8
 * 会注入网关 HttpOnly Cookie）能被一条链接带到任意外部 origin。
 *
 * 网关登录若需要在实例窗口内跳转（T7+），在此按需放开并补测试。
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
  if (!isLoopbackHost(target.hostname)) return false
  // 同端口：只留在自己的服务上，防串到其他实例或本机其他端口
  return target.port === origin.port
}
