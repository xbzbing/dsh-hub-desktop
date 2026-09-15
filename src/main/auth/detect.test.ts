import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyAuthResponse, detectAuthMode } from './detect'

const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

describe('classifyAuthResponse（§2.3 判定表）', () => {
  it('302 → /login = gateway（登录页）', () => {
    const result = classifyAuthResponse({ status: 302, location: '/dsh/login' })
    expect(result.mode).toBe('gateway')
    expect(result.gatewayEvidence).toBe('login-page')
  })

  it('302 → /onboarding = gateway（onboarding 未完成）', () => {
    expect(classifyAuthResponse({ status: 302, location: '/onboarding' }).gatewayEvidence).toBe('onboarding')
  })

  it('401 JSON unauthenticated = gateway（API 直探）', () => {
    const result = classifyAuthResponse({
      status: 401,
      contentType: 'application/json',
      body: '{"ok":false,"error":"unauthenticated"}'
    })
    expect(result.mode).toBe('gateway')
    expect(result.gatewayEvidence).toBe('api-401')
  })

  it('401 JSON onboarding-required = gateway(onboarding)', () => {
    const result = classifyAuthResponse({
      status: 401,
      contentType: 'application/json; charset=utf-8',
      body: '{"ok":false,"error":"onboarding-required"}'
    })
    expect(result.gatewayEvidence).toBe('onboarding')
  })

  it('401 text/plain + dsh BrowserAuth 提示 = browser-auth（源码实测响应）', () => {
    const result = classifyAuthResponse({
      status: 401,
      contentType: 'text/plain; charset=utf-8',
      body: 'dsh web authentication required; reopen the URL printed by dsh web.\n'
    })
    expect(result.mode).toBe('browser-auth')
  })

  it('200 = none', () => {
    expect(classifyAuthResponse({ status: 200, body: '<html>dsh</html>' }).mode).toBe('none')
  })

  it('404/500 = unknown', () => {
    expect(classifyAuthResponse({ status: 404 }).mode).toBe('unknown')
    expect(classifyAuthResponse({ status: 503 }).mode).toBe('unknown')
  })
})

describe('detectAuthMode（真实 HTTP 往返,含 redirect:manual）', () => {
  it('302 → /login 不被跟随,识别为 gateway', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>login</html>')
        return
      }
      res.writeHead(302, { location: '/login' })
      res.end()
    })
    const result = await detectAuthMode(`http://127.0.0.1:${port}/`, { timeoutMs: 1000 })
    expect(result.mode).toBe('gateway')
    expect(result.status).toBe(302)
  })

  it('401 JSON = gateway(api-401)', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":"unauthenticated"}')
    })
    const result = await detectAuthMode(`http://127.0.0.1:${port}/`, { timeoutMs: 1000 })
    expect(result.mode).toBe('gateway')
  })

  it('200 = none', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><title>dsh</title></html>')
    })
    expect((await detectAuthMode(`http://127.0.0.1:${port}/`, { timeoutMs: 1000 })).mode).toBe('none')
  })

  it('ECONNREFUSED = unreachable（不抛异常）', async () => {
    const result = await detectAuthMode('http://127.0.0.1:1/', { timeoutMs: 500 })
    expect(result.mode).toBe('unreachable')
    expect(result.status).toBeNull()
  })
})
