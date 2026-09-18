/**
 *
 * 手写而非依赖 fetch 的自动 Cookie 管理:
 * - 会话 Cookie `dsh_auth` 是 HttpOnly 的,必须由主进程显式持有并注入分区;
 * - 请求显式带 Cookie 头,响应显式解析 Set-Cookie(禁用自动重定向与隐式状态)。
 */

export interface CookieRecord {
  name: string
  value: string
  /** epoch ms;null = 会话 Cookie(无 Max-Age/Expires) */
  expiresAt: number | null
  /** Set-Cookie 的原始属性(诊断/审计用,不含值) */
  attributes: string
}

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const COOKIE_VALUE_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/

/** 解析单个 Set-Cookie 头(只取第一个 name=value 对与属性) */
export function parseSetCookie(header: string, now = Date.now()): CookieRecord | null {
  const trimmed = header.trim()
  if (trimmed === '') return null
  const parts = trimmed.split(';')
  const first = parts[0] ?? ''
  const eq = first.indexOf('=')
  if (eq <= 0) return null
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  if (!COOKIE_NAME_PATTERN.test(name) || !COOKIE_VALUE_PATTERN.test(value)) return null

  let expiresAt: number | null = null
  let maxAge: number | null = null
  let hasExpires = false
  for (const raw of parts.slice(1)) {
    const attr = raw.trim()
    const attrEq = attr.indexOf('=')
    const key = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase()
    const attrValue = attrEq === -1 ? '' : attr.slice(attrEq + 1).trim()
    if (key === 'max-age') {
      const parsed = Number(attrValue)
      if (Number.isInteger(parsed)) maxAge = parsed
    } else if (key === 'expires') {
      hasExpires = true
      const parsed = Date.parse(attrValue)
      if (!Number.isNaN(parsed)) expiresAt = parsed
    }
  }
  // Max-Age 优先于 Expires(RFC 6265);Max-Age<=0 表示删除
  if (maxAge !== null) expiresAt = now + maxAge * 1000
  else if (!hasExpires) expiresAt = null

  return { name, value, expiresAt, attributes: parts.slice(1).join(';').trim() }
}

export function isExpired(cookie: CookieRecord, now = Date.now()): boolean {
  return cookie.expiresAt !== null && cookie.expiresAt <= now
}

export interface CookieJar {
  /** 记录/覆盖来自 Set-Cookie 的 Cookie(Max-Age<=0 视为删除) */
  store(setCookieHeaders: string[]): void
  /** 请求用 Cookie 头(无有效 Cookie 返回 null) */
  header(): string | null
  /** 读取某 Cookie(已过期视为不存在) */
  get(name: string): CookieRecord | null
  /** 清空(登出/会话失效) */
  clear(): void
  /** 仅元信息快照(不含值,供 UI/审计) */
  describe(): Array<{ name: string; expiresAt: number | null; attributes: string }>
}

export function createCookieJar(now: () => number = () => Date.now()): CookieJar {
  const jar = new Map<string, CookieRecord>()
  return {
    store(setCookieHeaders) {
      for (const header of setCookieHeaders) {
        const record = parseSetCookie(header, now())
        if (!record) continue
        if (record.value === '' || (record.expiresAt !== null && record.expiresAt <= now())) {
          jar.delete(record.name)
          continue
        }
        jar.set(record.name, record)
      }
    },
    header() {
      const valid = [...jar.values()].filter((cookie) => !isExpired(cookie, now()))
      if (valid.length === 0) return null
      return valid.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    },
    get(name) {
      const cookie = jar.get(name)
      if (!cookie || isExpired(cookie, now())) return null
      return cookie
    },
    clear() {
      jar.clear()
    },
    describe() {
      return [...jar.values()].map((cookie) => ({
        name: cookie.name,
        expiresAt: cookie.expiresAt,
        attributes: cookie.attributes
      }))
    }
  }
}
