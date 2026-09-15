/**
 * 302/401 拦截（T8,设计文档 §6.3）—— 判定为纯函数,便于单测;electron 侧只做接线。
 *
 * 只监视**导航与主文档**请求:
 * - `302 → <basePath>/login`            → 会话失效(session-expired)
 * - `401 JSON error=unauthenticated`    → 会话失效
 * - `401 JSON error=otp-required`       → 需要二因素(needs-otp)
 * - `401 JSON error=onboarding-required`→ 需要先改初始密码(needs-onboarding)
 * **WebSocket 断开不作为重连判定依据**(网关 README:WS 无限重连是常态)。
 */

export type AuthSignal = 'session-expired' | 'needs-otp' | 'needs-onboarding'

export interface NavigationResponse {
  statusCode: number
  /** 响应头(大小写不敏感读取) */
  headers: Record<string, string | string[] | undefined>
  /** 请求 URL(用于区分导航/子资源) */
  url?: string
  /** 请求方法(仅主文档导航才算) */
  method?: string
  /** 是否为主框架导航 */
  isMainFrame?: boolean
  /** 响应体片段(401 判定 JSON error 用;可能为空) */
  body?: string | null
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue
    if (Array.isArray(value)) return value[0] ?? null
    return value ?? null
  }
  return null
}

/** 从 Location 取 pathname(相对路径按 base 归一化) */
export function locationPathname(location: string | null): string {
  if (!location) return ''
  try {
    return new URL(location, 'http://placeholder.invalid').pathname.toLowerCase()
  } catch {
    return location.toLowerCase()
  }
}

/**
 * 判定一次响应是否构成认证信号。
 * @param basePath 实例 basePath(如 '/dsh' 或 '/'),用于确认 /login 归属本实例
 */
export function classifyAuthSignal(
  response: NavigationResponse,
  basePath = '/'
): AuthSignal | null {
  const normalizedBase = basePath === '/' ? '' : basePath.replace(/\/+$/, '').toLowerCase()

  if (response.statusCode >= 300 && response.statusCode < 400) {
    const location = locationPathname(headerValue(response.headers, 'location'))
    if (location === '') return null
    const expectedLogin = `${normalizedBase}/login`
    // 允许带查询串/尾斜杠的等价形式
    const normalizedLocation = location.replace(/\/+$/, '')
    if (normalizedLocation === expectedLogin) return 'session-expired'
    return null
  }

  if (response.statusCode === 401) {
    const body = response.body ?? ''
    let error = ''
    try {
      const parsed = JSON.parse(body) as { error?: unknown }
      if (typeof parsed.error === 'string') error = parsed.error
    } catch {
      // 体不可解析时退化为文本匹配(网关始终返回 JSON,这里是防御)
      if (body.includes('unauthenticated')) error = 'unauthenticated'
    }
    if (error === 'unauthenticated') return 'session-expired'
    if (error === 'otp-required') return 'needs-otp'
    if (error === 'onboarding-required') return 'needs-onboarding'
    return null
  }

  return null
}
