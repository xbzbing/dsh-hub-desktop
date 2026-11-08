import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }))
vi.mock('electron', () => ({ net: { request: requestMock } }))

import { createSessionFetch } from './session-fetch'

class FakeRequest extends EventEmitter {
  abort = vi.fn()

  constructor(private readonly onEnd: (request: FakeRequest) => void) {
    super()
  }

  end = vi.fn((): void => {
    this.onEnd(this)
  })
}

class FakeResponse extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string | string[]>,
    private readonly body: string
  ) {
    super()
  }
}

const session = {} as never

function fakeFetch(onEnd: (request: FakeRequest) => void): typeof fetch {
  requestMock.mockImplementation(() => new FakeRequest(onEnd))
  return createSessionFetch({ session })
}

function emitResponse(request: FakeRequest, response: FakeResponse): void {
  request.emit('response', response)
  response.emit('data', Buffer.from('hello'))
  response.emit('end')
}

describe('createSessionFetch（Electron net.request → fetch 形状）', () => {
  it('manual 重定向：把 redirect 事件当成 302 响应，拿到 Location', async () => {
    const fetchImpl = fakeFetch((request) => {
      setImmediate(() => {
        request.emit('redirect', 302, 'GET', 'http://target.invalid/login', {
          location: ['/login']
        })
        request.emit('error', new Error('Redirect was cancelled'))
      })
    })
    const response = await fetchImpl('http://target.invalid/', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login')
    expect(await response.text()).toBe('')
  })

  it('普通响应保留状态、正文与多个 Set-Cookie', async () => {
    const fetchImpl = fakeFetch((request) => {
      setImmediate(() =>
        emitResponse(
          request,
          new FakeResponse(
            200,
            {
              'content-type': 'text/plain',
              'set-cookie': ['a=1; Path=/', 'b=2; Path=/']
            },
            'hello'
          )
        )
      )
    })
    const response = await fetchImpl('http://target.invalid/', { redirect: 'manual' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
    const withGetter = response.headers as Headers & { getSetCookie?: () => string[] }
    expect(withGetter.getSetCookie?.()).toEqual(['a=1; Path=/', 'b=2; Path=/'])
  })

  it('代理 login 事件回填 vault 中的用户名与密码', async () => {
    const auth = { username: 'alice', password: 'secret' }
    let seen: [string | undefined, string | undefined] | null = null
    requestMock.mockImplementation((options: unknown) => {
      const request = new FakeRequest((self) => {
        setImmediate(() => {
          self.emit(
            'login',
            { isProxy: true, host: 'proxy', port: 8080 },
            (u?: string, p?: string) => {
              seen = [u, p]
            }
          )
          emitResponse(self, new FakeResponse(200, {}, ''))
        })
      })
      expect(options).toMatchObject({ session })
      return request
    })
    const fetchImpl = createSessionFetch({ session, auth })
    await fetchImpl('http://target.invalid/')
    expect(seen).toEqual(['alice', 'secret'])
  })

  it('已中止的 signal 不创建请求', async () => {
    const fetchImpl = createSessionFetch({ session })
    requestMock.mockClear()
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchImpl('http://target.invalid/', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestMock).not.toHaveBeenCalled()
  })
})
