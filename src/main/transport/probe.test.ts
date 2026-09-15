import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { httpHealthProbe } from './probe'

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

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server)
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

describe('httpHealthProbe（§4.3）', () => {
  it('200 = 就绪', async () => {
    const port = await listen(
      createServer((_req, res) => {
        res.writeHead(200)
        res.end('ok')
      })
    )
    expect(await httpHealthProbe(`http://127.0.0.1:${port}/`, 1000)).toBe(true)
  })

  it('401 = 就绪（认证层随后再区分）', async () => {
    const port = await listen(
      createServer((_req, res) => {
        res.writeHead(401)
        res.end('unauthorized')
      })
    )
    expect(await httpHealthProbe(`http://127.0.0.1:${port}/`, 1000)).toBe(true)
  })

  it('R4 回归:302 重定向到不可达地址仍算就绪（redirect: manual）', async () => {
    const port = await listen(
      createServer((_req, res) => {
        // 重定向到不可达地址:若跟随重定向会失败 → 被判未就绪(评审 R4)
        res.writeHead(302, { Location: 'http://127.0.0.1:1/nowhere' })
        res.end()
      })
    )
    expect(await httpHealthProbe(`http://127.0.0.1:${port}/`, 1000)).toBe(true)
  })

  it('连接被拒 = 未就绪', async () => {
    expect(await httpHealthProbe('http://127.0.0.1:1/', 500)).toBe(false)
  })
})
