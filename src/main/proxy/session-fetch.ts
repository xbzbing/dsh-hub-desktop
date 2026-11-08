/**
 * 把 Electron 的 `net.request` 适配成认证层/探测层使用的 fetch 形状。
 *
 * 为什么不用 Node 的 `fetch`：远程 HTTP 实例的代理配置挂在 Chromium 分区 session 上，
 * 只有 `net.request({ session })` 会走该 session 的代理；Node fetch 不读 Chromium 代理。
 * 为什么不用 `session.fetch`：它在 `redirect: 'manual'` 时会直接以
 * “Redirect was cancelled” 拒绝，拿不到 302/Location，而认证探测必须看到重定向本身。
 *
 * 本模块只实现认证与健康探测用到的子集：GET/POST、字符串 body、manual/follow redirect、
 * AbortSignal、响应状态/头/文本。代理认证来自 vault 的密码，经 `login` 事件交给 Chromium。
 */
import { net, type AuthInfo, type Session } from 'electron'

export interface ProxyAuth {
  username: string
  password: string
}

export interface SessionFetchOptions {
  session: Session
  /** 代理要求认证时提供；不做 Basic 头预置，交给 Chromium 的 login 事件。 */
  auth?: ProxyAuth | null
}

type ResponseHeaders = Record<string, string | string[]>

function normalizedHeaderValues(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value]
}

function headersOf(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {}
  const source = init.headers
  if (!source) return headers
  if (source instanceof Headers) {
    source.forEach((value, name) => {
      headers[name] = value
    })
    return headers
  }
  if (Array.isArray(source)) {
    for (const [name, value] of source) {
      if (value !== undefined) headers[name] = value
    }
    return headers
  }
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined) headers[name] = value
  }
  return headers
}

function bodyOf(init: RequestInit): string | Buffer | undefined {
  const body = init.body
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  throw new TypeError('session fetch 只支持字符串/URLSearchParams/二进制 body')
}

function responseOf(status: number, rawHeaders: ResponseHeaders, body: Buffer | null): Response {
  const headers = new Headers()
  for (const [name, value] of Object.entries(rawHeaders)) {
    for (const item of normalizedHeaderValues(value)) headers.append(name, item)
  }
  // 204/205/304 不允许携带响应体，Response 构造器会拒绝非 null body。
  const withoutBody = status === 204 || status === 205 || status === 304
  return new Response(withoutBody ? null : body, { status, headers })
}

/** 用指定 session 发起请求的 fetch 兼容实现；调用方负责先应用代理。 */
export function createSessionFetch(options: SessionFetchOptions): typeof fetch {
  const fetchImpl = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = headersOf(init)
    const body = bodyOf(init)
    const redirect = init.redirect ?? 'follow'
    const signal = init.signal

    return await new Promise<Response>((resolve, reject) => {
      let settled = false
      const finish = (response: Response): void => {
        if (settled) return
        settled = true
        resolve(response)
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      if (signal?.aborted) {
        fail(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
        return
      }

      const request = net.request({
        url,
        session: options.session,
        method,
        headers,
        redirect: redirect === 'manual' ? 'manual' : redirect === 'error' ? 'error' : 'follow',
        // 认证层自己管理 Cookie 罐，不允许 session 里的 Cookie 串进请求。
        useSessionCookies: false
      })

      request.on('login', (authInfo: AuthInfo, callback: (u?: string, p?: string) => void) => {
        if (authInfo.isProxy && options.auth) callback(options.auth.username, options.auth.password)
      })

      if (redirect === 'manual') {
        // manual 模式下 Chromium 不产生 response，只给 redirect 事件，随后以
        // “Redirect was cancelled” 报错。把 redirect 事件本身当成响应返回。
        request.on(
          'redirect',
          (statusCode: number, _method: string, _url: string, responseHeaders: ResponseHeaders) => {
            finish(responseOf(statusCode, responseHeaders, null))
          }
        )
      }

      request.on('response', (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          finish(responseOf(response.statusCode, response.headers, Buffer.concat(chunks)))
        })
        response.on('error', fail)
      })
      request.on('error', (error: Error) => {
        // manual 重定向在 redirect 事件后还会补一个“Redirect was cancelled”；
        // 此时响应已经解析，忽略后续错误即可。
        if (settled) return
        fail(error)
      })
      request.on('abort', () => {
        if (settled) return
        fail(new DOMException('The operation was aborted', 'AbortError'))
      })

      const onAbort = (): void => {
        if (settled) return
        request.abort()
        fail(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      request.on('close', () => signal?.removeEventListener('abort', onAbort))
      request.end(body)
    })
  }

  return fetchImpl as typeof fetch
}
