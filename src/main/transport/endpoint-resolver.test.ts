import { describe, expect, it } from 'vitest'
import type { HttpInstance } from '@shared/contracts'
import { httpDirectEndpoint, sshTunnelEndpoint } from './endpoint-resolver'

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