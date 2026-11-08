/**
 * 安全检查的 HTTP 取数：限时、限量、只读。
 *
 * 不跟随跨域重定向由调用方按 URL 白名单另行约束；这里只负责「拿多少、等多久」。
 * 失败统一抛 `SecurityFetchError`，由编排层决定降级为 skip/unavailable。
 */
import { SECURITY_LIMITS } from './limits'

export interface FetchOptions {
  timeoutMs?: number
  maxBytes?: number
  headers?: Record<string, string>
}

export type SecurityFetchErrorCode = 'http' | 'network' | 'timeout' | 'too-large' | 'parse'

export class SecurityFetchError extends Error {
  readonly code: SecurityFetchErrorCode
  readonly status: number | null

  constructor(code: SecurityFetchErrorCode, message: string, status: number | null = null) {
    super(message)
    this.name = 'SecurityFetchError'
    this.code = code
    this.status = status
  }
}

const USER_AGENT = 'dsh-hub-desktop'

function headersOf(extra: Record<string, string> | undefined): Record<string, string> {
  return { 'user-agent': USER_AGENT, ...extra }
}

function timeoutOf(options: FetchOptions): number {
  return options.timeoutMs ?? SECURITY_LIMITS.requestTimeoutMs
}

function maxOf(options: FetchOptions): number {
  return options.maxBytes ?? SECURITY_LIMITS.maxManifestBytes
}

/** 读取响应体并按上限截断；Content-Length 先判一次，流式读取再判一次。 */
async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SecurityFetchError('too-large', `响应超过上限 ${maxBytes} 字节`)
  }
  if (response.body === null) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new SecurityFetchError('too-large', `响应超过上限 ${maxBytes} 字节`)
    }
    return buffer
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new SecurityFetchError('too-large', `响应超过上限 ${maxBytes} 字节`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** 默认取字节实现：非 2xx、超时、网络失败、超限分别映射到稳定错误码。 */
export async function defaultFetchBytes(url: string, options: FetchOptions = {}): Promise<Buffer> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: headersOf(options.headers),
      signal: AbortSignal.timeout(timeoutOf(options))
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new SecurityFetchError('timeout', `请求超时：${url}`)
    }
    throw new SecurityFetchError('network', `网络请求失败：${url}`)
  }
  if (!response.ok) {
    throw new SecurityFetchError('http', `HTTP ${response.status}：${url}`, response.status)
  }
  return readLimited(response, maxOf(options))
}

/** 默认取 JSON 实现：复用字节读取与上限，解析失败映射为 parse。 */
export async function defaultFetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  const bytes = await defaultFetchBytes(url, options)
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new SecurityFetchError('parse', `无法解析 JSON：${url}`)
  }
}

/** 默认 POST JSON 实现（OSV 查询）；响应同样有上限。 */
export async function defaultPostJson(
  url: string,
  body: unknown,
  options: FetchOptions = {}
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: headersOf({ 'content-type': 'application/json', ...options.headers }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutOf(options))
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new SecurityFetchError('timeout', `请求超时：${url}`)
    }
    throw new SecurityFetchError('network', `网络请求失败：${url}`)
  }
  if (!response.ok) {
    throw new SecurityFetchError('http', `HTTP ${response.status}：${url}`, response.status)
  }
  const bytes = await readLimited(response, maxOf(options))
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new SecurityFetchError('parse', `无法解析 JSON：${url}`)
  }
}

export interface SecurityFetcher {
  fetchJson(url: string, options?: FetchOptions): Promise<unknown>
  fetchBytes(url: string, options?: FetchOptions): Promise<Buffer>
  postJson(url: string, body: unknown, options?: FetchOptions): Promise<unknown>
}

/** 生产默认取数器；测试注入替身。 */
export const defaultSecurityFetcher: SecurityFetcher = {
  fetchJson: defaultFetchJson,
  fetchBytes: defaultFetchBytes,
  postJson: defaultPostJson
}
