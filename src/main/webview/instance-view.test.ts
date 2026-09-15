import { describe, expect, it, vi } from 'vitest'
import { openInstanceView } from './instance-view'
import type { InstanceViewWindow, OpenInstanceViewDeps } from './instance-view'

const COOKIE = { name: 'dsh_auth', value: 'sess-token', expiresAt: null }

/**
 * 录制开窗顺序的假窗口。
 * 顺序纪律(§6.2):createWindow → installIntercept → cookies.set → loadURL。
 */
function harness(): {
  deps: OpenInstanceViewDeps<InstanceViewWindow>
  order: string[]
  loaded: string[]
  setDetails: Array<Record<string, unknown>>
} {
  const order: string[] = []
  const loaded: string[] = []
  const setDetails: Array<Record<string, unknown>> = []
  const win: InstanceViewWindow = {
    loadURL: async (url: string) => {
      order.push('loadURL')
      loaded.push(url)
    },
    webContents: {
      session: {
        cookies: {
          set: async (details) => {
            order.push('cookies.set')
            setDetails.push(details as unknown as Record<string, unknown>)
          }
        }
      }
    }
  }
  return {
    order,
    loaded,
    setDetails,
    deps: {
      createWindow: () => {
        order.push('createWindow')
        return win
      },
      installIntercept: () => {
        order.push('installIntercept')
      }
    }
  }
}

const args = {
  url: 'http://127.0.0.1:8002/?token=abc',
  origin: 'http://127.0.0.1:8002',
  basePath: '/',
  cookie: COOKIE
}

describe('openInstanceView（§6.2 先注入再 loadURL 的顺序纪律）', () => {
  it('调用顺序必须是 开窗 → 装拦截 → 写 Cookie → loadURL', async () => {
    const h = harness()
    const injected = await openInstanceView(h.deps, args)
    expect(injected).toBe(true)
    expect(h.order).toEqual(['createWindow', 'installIntercept', 'cookies.set', 'loadURL'])
  })

  it('写入的 Cookie 带 HttpOnly/Path=/ 与正确 url', async () => {
    const h = harness()
    await openInstanceView(h.deps, args)
    expect(h.setDetails).toHaveLength(1)
    expect(h.setDetails[0]).toMatchObject({
      url: 'http://127.0.0.1:8002/',
      name: 'dsh_auth',
      value: 'sess-token',
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/'
    })
  })

  it('加载的是确切 URL(不被 origin+basePath 重建,保留 ?token=)', async () => {
    const h = harness()
    await openInstanceView(h.deps, args)
    expect(h.loaded).toEqual(['http://127.0.0.1:8002/?token=abc'])
  })

  it('无会话时只开窗+装拦截+加载,不写 Cookie', async () => {
    const h = harness()
    const injected = await openInstanceView(h.deps, { ...args, cookie: null })
    expect(injected).toBe(false)
    expect(h.order).toEqual(['createWindow', 'installIntercept', 'loadURL'])
    expect(h.setDetails).toEqual([])
  })

  it('Cookie 注入失败仍继续加载(交给拦截层触发重登)', async () => {
    const h = harness()
    h.deps.createWindow = (() => {
      h.order.push('createWindow')
      return {
        loadURL: async (url: string) => {
          h.order.push('loadURL')
          h.loaded.push(url)
        },
        webContents: {
          session: {
            cookies: {
              set: async () => {
                h.order.push('cookies.set')
                throw new Error('network service 不可用')
              }
            }
          }
        }
      }
    }) as OpenInstanceViewDeps<InstanceViewWindow>['createWindow']
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const injected = await openInstanceView(h.deps, args)
    errorSpy.mockRestore()
    expect(injected).toBe(false)
    expect(h.order).toEqual(['createWindow', 'installIntercept', 'cookies.set', 'loadURL'])
  })

  it('加载失败经 onLoadError 上报,不向调用方抛出', async () => {
    const errors: unknown[] = []
    const deps: OpenInstanceViewDeps<InstanceViewWindow> = {
      createWindow: () => ({
        loadURL: async () => {
          throw new Error('ERR_CONNECTION_REFUSED')
        },
        webContents: { session: { cookies: { set: async () => undefined } } }
      }),
      installIntercept: () => undefined,
      onLoadError: (error) => errors.push(error)
    }
    await expect(openInstanceView(deps, args)).resolves.toBe(true)
    expect(errors).toHaveLength(1)
  })
})
