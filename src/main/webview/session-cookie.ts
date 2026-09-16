/**
 *
 * 登出/实例删除/切换账号时必须清掉分区内的 `dsh_auth`,否则 webview 仍带着旧会话
 * 访问受保护页面(「已登出却还能看」)。Cookie 的 url 只需 origin(basePath 不影响 path)。
 */

import { cookieUrlFor } from './cookie-import'

export interface SessionCookieRemover {
  remove(url: string, name: string): Promise<void>
  get?(filter: { url?: string; name?: string }): Promise<Array<{ name: string }>>
}

export interface ClearSessionCookieOptions {
  origin: string
  basePath?: string
  cookieName?: string
}

export const DEFAULT_SESSION_COOKIE = 'dsh_auth'

/**
 * 与注入共用同一 url 规则(单一实现见 `cookie-import.cookieUrlFor`)
 * —— 注入与清理必须命中同一个 Cookie,规则分叉会出现「清了但没清掉」。
 */
export const sessionCookieUrl = cookieUrlFor

/** 清理分区会话 Cookie;失败不抛(登出流程不因清理失败而中断) */
export async function clearSessionCookie(
  remover: SessionCookieRemover,
  options: ClearSessionCookieOptions
): Promise<boolean> {
  const url = sessionCookieUrl(options.origin, options.basePath ?? '/')
  const name = options.cookieName ?? DEFAULT_SESSION_COOKIE
  try {
    await remover.remove(url, name)
    return true
  } catch (error) {
    console.error('[session-cookie] 分区 Cookie 清理失败：', error)
    return false
  }
}

/** 从实例视图 URL 推导 origin(用于清理) */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}
