/**
 * 分区会话 Cookie 清理（T9,设计文档 §5.4）—— 纯逻辑 + 注入式 session,不 import electron。
 *
 * 登出/实例删除/切换账号时必须清掉分区内的 `dsh_auth`,否则 webview 仍带着旧会话
 * 访问受保护页面(「已登出却还能看」)。Cookie 的 url 只需 origin(basePath 不影响 path)。
 */

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

/** 与注入保持一致的 url 规则(见 cookie-import.cookieUrlFor) */
export function sessionCookieUrl(origin: string, basePath = '/'): string {
  const trimmed = origin.replace(/\/+$/, '')
  const base = basePath === '/' || basePath === '' ? '' : basePath.replace(/\/+$/, '')
  return `${trimmed}${base}/`
}

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
