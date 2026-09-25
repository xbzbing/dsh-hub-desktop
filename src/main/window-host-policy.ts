/**
 *
 * `setWindowOpenHandler` 只挡住弹窗，顶层 `<a href>` / form 提交必须在这里拦截，
 * 否则 `persist:inst-<id>` 分区（网关 HttpOnly Cookie 所在）能被一条链接带到任意外部 origin。
 *
 * 放行面（两选一）:
 * ① **同 origin**(http 远程实例的全部页面 —— 网关登录页 / OTP / onboarding / 工作区
 * ② **回环主机 + 同端口**(local/ssh 实例;localhost/[::1]/127.1 等回环别名视为同一服务,
 *    跨端口拒绝防串到其他实例或本机其他服务)。
 */
import { isLoopbackHost } from '@shared/endpoint'

function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/**
 * 可交给系统默认程序打开的外跳协议白名单。
 * 其余协议（`file:`、`search-ms:`、`ms-settings:` 等）能在宿主上拉起本地程序或文件，
 * 远程工作区内容不可信，一律拒绝。
 */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export function isAllowedExternalOpen(targetUrl: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(targetUrl).protocol)
  } catch {
    return false
  }
}

/**
 * 白名单内的 URL 交给系统打开；拒绝的协议直接丢弃，打开失败按关闭处理
 * （`shell.openExternal` 拒绝的 Promise 必须消费，否则成为未处理拒绝）。
 * @returns 是否已发起打开
 */
export function openExternalSafely(
  targetUrl: string,
  openExternal: (url: string) => Promise<void>
): boolean {
  if (!isAllowedExternalOpen(targetUrl)) return false
  void openExternal(targetUrl).catch(() => undefined)
  return true
}

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
  return target.protocol === origin.protocol && effectivePort(target) === effectivePort(origin)
}
