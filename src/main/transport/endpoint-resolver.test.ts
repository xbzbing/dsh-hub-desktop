import { describe, expect, it } from 'vitest'
import type { HttpInstance, InstanceRecord } from '@shared/contracts'
import { authEndpointOf, httpDirectEndpoint, sshTunnelEndpoint } from './endpoint-resolver'

describe('endpoint-resolver（实例 → 最终端点 URL 唯一出口）', () => {
  it('ssh 隧道端点一律是回环 + 本地分配端口', () => {
    expect(sshTunnelEndpoint(30123)).toBe('http://127.0.0.1:30123/')
    expect(sshTunnelEndpoint(65535)).toBe('http://127.0.0.1:65535/')
  })

  it('http 直连：归一化 baseUrl + 根路径', () => {
    const instance: HttpInstance = {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      name: '远程',
      transport: 'http',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z'
    }
    expect(httpDirectEndpoint(instance)).toBe('https://gw.example.com/dsh/')
  })

  it('http 直连：反代子路径保留', () => {
    const instance: HttpInstance = {
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      name: '远程',
      transport: 'http',
      authMode: 'none',
      endpointUrl: 'http://127.0.0.1:3080/sub/',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z'
    }
    expect(httpDirectEndpoint(instance)).toBe('http://127.0.0.1:3080/sub/')
  })
})

describe('authEndpointOf（认证探测端点,评审 R7）', () => {
  const http = {
    id: '11111111-1111-4111-8111-111111111111',
    name: '远程',
    authMode: 'gateway',
    transport: 'http',
    endpointUrl: 'https://gw.example.com/dsh',
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z'
  } as unknown as InstanceRecord
  const ssh = { ...http, transport: 'ssh', host: '10.0.0.9' } as unknown as InstanceRecord
  const local = { ...http, transport: 'local' } as unknown as InstanceRecord

  it('http 直接用直连端点', () => {
    expect(authEndpointOf(http, undefined)).toBe('https://gw.example.com/dsh')
  })

  it('ssh 用隧道本地口(隧道未就绪 → null,旧实现恒为 null 导致登录按钮是死的)', () => {
    expect(authEndpointOf(ssh, 32222)).toBe('http://127.0.0.1:32222/')
    expect(authEndpointOf(ssh, undefined)).toBeNull()
  })

  it('local 走 BrowserAuth,不经网关登录', () => {
    expect(authEndpointOf(local, undefined)).toBeNull()
  })
})
