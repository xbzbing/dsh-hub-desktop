/**
 *
 * 网关(`dsh-auth-gateway` `Gateway#route`)对同一认证状态按**资源类型**给两种响应:
 * - 页面/导航路径     → `302` 到 `<basePath>/login` | `/onboarding` | `/otp/verify`
 * - `/api*` 子资源    → `401` JSON(`error` 分别 unauthenticated / onboarding-required / otp-required)
 *
 * **401 只认网关的 JSON 形态**:网关对 `/api*` 恒返回 `content-type: application/json`,
 * 而 dsh 内置 BrowserAuth 的 401 是 `text/plain` + 固定文案(detect.ts 的
 * `BROWSER_AUTH_MARKER`)。二者都用 401,若不加 content-type 判别,
 * 会凭空弹出网关登录面板)。
 *
 * **本层为什么不解析 401 响应体**:`webRequest.onHeadersReceived` 的 details
 * (Electron 43 `OnHeadersReceivedListenerDetails`)只有 `statusCode/headers/resourceType/...`,
 * **不含响应体**;`filterResponseData` 在 Electron 43 不存在,也无其它取体途径。
 * 因此 401 只按状态码判定为 `session-expired`(不区分三者),
 * **真实状态由主进程 `auth.probe()` 直连并读体裁决** —— 拦截层只是触发器,不承担状态机职责。
 * 三种状态的精确区分由页面 302 的 location 完成(下方映射)。
 *
 * 不变式(测试锁定):
 * 1. `302` 只在**主框架导航**上判定 —— 子资源 302 是普通重定向(如登录接口自身);
 * 2. 判定只依赖状态码 + location,不依赖响应体。
 *
 * **WebSocket 断开不作为重连判定依据**(网关 README:WS 无限重连是常态)。
 */

export type AuthSignal = 'session-expired' | 'needs-otp' | 'needs-onboarding'

export interface NavigationResponse {
  statusCode: number
  /** 响应头(大小写不敏感读取) */
  headers: Record<string, string | string[] | undefined>
  /** electron `details.resourceType`;302 仅在 `'mainFrame'` 上判定 */
  resourceType?: string
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
 * @param basePath 实例 basePath(如 '/dsh' 或 '/'),用于确认 location 归属本实例
 */
export function classifyAuthSignal(
  response: NavigationResponse,
  basePath = '/'
): AuthSignal | null {
  const normalizedBase = basePath === '/' ? '' : basePath.replace(/\/+$/, '').toLowerCase()

  if (response.statusCode >= 300 && response.statusCode < 400) {
    // 不变式 1:只有主框架导航才代表「页面被拦到登录/引导/验证码」
    if (response.resourceType !== 'mainFrame') return null
    const location = locationPathname(headerValue(response.headers, 'location'))
    if (location === '') return null
    // 允许尾斜杠的等价形式
    const normalizedLocation = location.replace(/\/+$/, '')
    if (normalizedLocation === `${normalizedBase}/login`) return 'session-expired'
    if (
      normalizedLocation === `${normalizedBase}/onboarding` ||
      normalizedLocation === `${normalizedBase}/onboarding/password`
    ) {
      return 'needs-onboarding'
    }
    if (normalizedLocation === `${normalizedBase}/otp/verify`) return 'needs-otp'
    return null
  }

  // 不变式 2:401 必须是网关的 JSON 形态(排除 dsh BrowserAuth 的 text/plain 401)。
  // `/api*` 的三个 error 码在无响应体时不可区分 —— 页面 302 的 location 才是区分依据,
  // 其余由 auth.probe() 的探测证据(gatewayEvidence)裁决。
  if (response.statusCode === 401) {
    const contentType = headerValue(response.headers, 'content-type')
    return contentType !== null && contentType.toLowerCase().includes('json')
      ? 'session-expired'
      : null
  }

  return null
}
