/**
 * 分区 Cookie 注入（T8,设计文档 §6.2）—— 纯逻辑 + 注入式 session,不 import electron 类型。
 *
 * 登录由主进程完成(§5.3),成功后把会话 Cookie 写入该实例分区:
 * `Path=/; HttpOnly; SameSite=Strict`(网关 Cookie 无 Secure;basePath 不改变 Cookie 路径)。
 * **顺序纪律**:先写分区 Cookie,再 loadURL —— 避免首帧 302 抖动。
 * 密码绝不进入渲染进程:渲染层只触发登录,凭据只在主进程内存中流转。
 */

export interface SessionCookieRecord {
  url: string
  name: string
  value: string
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'strict' | 'lax' | 'no_restriction' | 'unspecified'
  expirationDate?: number
}

/** electron `session.cookies.set` 的最小接口(便于单测注入) */
export interface CookieSetter {
  set(details: SessionCookieRecord): Promise<void>
}

export interface ImportCookieOptions {
  /** 端点 origin(含 scheme/port),如 https://gw.example.com */
  origin: string
  /** basePath(如 '/dsh');Cookie 路径仍为 '/'(设计 §6.4) */
  basePath?: string
  cookie: { name: string; value: string; expiresAt: number | null }
}

/** 计算 Cookie 写入用的 URL:Cookie 的 Path=/ 意味着 url 只需 origin(+basePath 不影响) */
export function cookieUrlFor(origin: string, basePath = '/'): string {
  const trimmedOrigin = origin.replace(/\/+$/, '')
  const normalizedBase = basePath === '/' || basePath === '' ? '' : basePath.replace(/\/+$/, '')
  return `${trimmedOrigin}${normalizedBase}/`
}

export function toCookieRecord(options: ImportCookieOptions): SessionCookieRecord {
  const { origin, basePath = '/', cookie } = options
  return {
    url: cookieUrlFor(origin, basePath),
    name: cookie.name,
    value: cookie.value,
    path: '/', // 网关源码核实:basePath 不改变 Cookie 路径
    httpOnly: true,
    secure: false, // 网关 Cookie 刻意不带 Secure(纯 HTTP/LAN 场景)
    sameSite: 'strict',
    ...(cookie.expiresAt === null ? {} : { expirationDate: Math.floor(cookie.expiresAt / 1000) })
  }
}

/** 注入会话 Cookie(写失败不致命:页面仍可打开,拦截层会触发重登) */
export async function importSessionCookie(
  setter: CookieSetter,
  options: ImportCookieOptions
): Promise<boolean> {
  try {
    await setter.set(toCookieRecord(options))
    return true
  } catch (error) {
    console.error('[cookie-import] 分区 Cookie 注入失败：', error)
    return false
  }
}

/**
 * 实例视图加载前的编排:先注入 Cookie 再 loadURL(§6.2 顺序纪律)。
 * @returns 是否成功注入(调用方据此决定是否仍要 loadURL —— 失败也加载,交给拦截层)
 */
export async function prepareInstanceView(
  setter: CookieSetter,
  options: ImportCookieOptions,
  loadUrl: (url: string) => Promise<void> | void
): Promise<boolean> {
  const injected =
    options.cookie.value === '' ? false : await importSessionCookie(setter, options)
  await loadUrl(cookieUrlFor(options.origin, options.basePath ?? '/'))
  return injected
}
