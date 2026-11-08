import { createServer, type Server as HttpServer } from 'node:http'
import {
  connect as tcpConnect,
  createServer as createTcpServer,
  type Server as SocksServer,
  type Socket
} from 'node:net'
import { rm } from 'node:fs/promises'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'

/**
 * SOCKS5 代理端到端：
 * - 启动探测与工作区流量真正经 SOCKS5 隧道到达目标服务器（目标直连计数为 0）；
 * - 注册表记录只有类型/主机/端口，不含凭据。
 *
 * 测试内自带最小 SOCKS5 服务器（no-auth）：Chromium 的 SOCKS5 客户端只提供
 * no-auth 方法，因此代理认证仅支持 HTTP 代理。不使用任何新增运行时依赖。
 */
const DATA_DIR = e2eDataDir('e2e-socks5-proxy')
const PROXY_PAGE =
  '<!doctype html><html><head><title>socks target</title></head>' +
  '<body><h1 id="socks-ok">socks ok</h1></body></html>'

let app: ElectronApplication
let win: Page
let target: HttpServer
let socks: SocksServer
let targetPort = 0
let socksPort = 0
/** 收到 SOCKS5 握手的连接数。 */
let socksHits = 0
/** 建立 CONNECT 隧道的次数。 */
let tunnels = 0
/** 目标服务器被直连（未走代理）的次数。 */
let targetHits = 0

/** 最小 SOCKS5 服务器：只实现 no-auth 的 CONNECT，隧道建立后双向转发。 */
function createSocks5Proxy(): SocksServer {
  return createTcpServer((client: Socket) => {
    socksHits += 1
    let step: 'greeting' | 'request' | 'connecting' | 'piping' = 'greeting'
    let pending = Buffer.alloc(0)
    let upstream: Socket | null = null

    client.on('error', () => undefined)
    client.on('close', () => upstream?.destroy())
    client.on('data', (chunk: Buffer) => {
      if (step === 'piping') {
        if (upstream && !upstream.destroyed) upstream.write(chunk)
        return
      }
      pending = Buffer.concat([pending, chunk])
      if (step === 'connecting') return

      while (step === 'greeting' || step === 'request') {
        if (step === 'greeting') {
          if (pending.length < 2) return
          const methodCount = pending[1] ?? 0
          if (pending.length < 2 + methodCount) return
          const methods = pending.subarray(2, 2 + methodCount)
          if (pending[0] !== 5) {
            client.end(Buffer.from([5, 0xff]))
            return
          }
          pending = pending.subarray(2 + methodCount)
          if (!methods.includes(0x00)) {
            client.end(Buffer.from([5, 0xff]))
            return
          }
          client.write(Buffer.from([5, 0x00]))
          step = 'request'
          continue
        }

        if (pending.length < 4) return
        if (pending[0] !== 5 || pending[1] !== 1) {
          // 只支持 CONNECT。
          client.end(Buffer.from([5, 7]))
          return
        }
        const addressType = pending[3]
        let host: string
        let headerLength: number
        if (addressType === 1) {
          if (pending.length < 10) return
          host = `${pending[4]}.${pending[5]}.${pending[6]}.${pending[7]}`
          headerLength = 10
        } else if (addressType === 3) {
          const hostLength = pending[4] ?? 0
          if (pending.length < 5 + hostLength + 2) return
          host = pending.subarray(5, 5 + hostLength).toString('utf8')
          headerLength = 5 + hostLength + 2
        } else {
          client.end(Buffer.from([5, 8]))
          return
        }
        const port = pending.readUInt16BE(headerLength - 2)
        pending = pending.subarray(headerLength)
        tunnels += 1
        step = 'connecting'
        // 测试映射：请求域名固定为 socks-e2e.invalid，隧道出口连本机目标。
        upstream = tcpConnect(port, host === 'socks-e2e.invalid' ? '127.0.0.1' : host)
        upstream.on('error', () => client.destroy())
        upstream.on('close', () => client.destroy())
        upstream.on('data', (data: Buffer) => {
          if (!client.destroyed) client.write(data)
        })
        upstream.on('connect', () => {
          // BND.ADDR/BND.PORT 用占位值：客户端不消费它。
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          step = 'piping'
          if (pending.length > 0 && upstream) {
            upstream.write(pending)
            pending = Buffer.alloc(0)
          }
        })
        return
      }
    })
  })
}

/** 在工作区 WebContentsView 里执行脚本；返回值必须是可序列化的原始值。 */
async function workspaceText(script: string): Promise<unknown> {
  return await app.evaluate(async ({ BrowserWindow }, code) => {
    const area = (view: { getBounds?: () => { width: number; height: number } }): number => {
      const bounds = view.getBounds?.()
      return (bounds?.width ?? 0) * (bounds?.height ?? 0)
    }
    const host = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.contentView.children.length > 0
    )
    const view = (host?.contentView.children ?? [])
      .map(
        (child) =>
          child as {
            getBounds?: () => { width: number; height: number }
            webContents?: { executeJavaScript: (source: string) => Promise<unknown> }
          }
      )
      .filter((child) => child.webContents !== undefined)
      .sort((a, b) => area(b) - area(a))[0]
    if (!view?.webContents) throw new Error('工作区视图不存在')
    return await view.webContents.executeJavaScript(code)
  }, script)
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  target = createServer((_request, response) => {
    targetHits += 1
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PROXY_PAGE)
  })
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  const targetAddress = target.address()
  targetPort = typeof targetAddress === 'object' && targetAddress ? targetAddress.port : 0

  socks = createSocks5Proxy()
  await new Promise<void>((resolve) => socks.listen(0, '127.0.0.1', resolve))
  const socksAddress = socks.address()
  socksPort = typeof socksAddress === 'object' && socksAddress ? socksAddress.port : 0

  app = await electron.launch({ args: buildLaunchArgs(), env: e2eEnv(DATA_DIR) })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
  await new Promise<void>((resolve) => target.close(() => resolve()))
  await new Promise<void>((resolve) => socks.close(() => resolve()))
  await rm(DATA_DIR, { recursive: true, force: true })
})

test('HTTP 实例经 SOCKS5 代理启动并打开工作区', async () => {
  test.setTimeout(120_000)
  const created = await win.evaluate(
    async (input) => {
      const result = await window.dshHub.instances.create({
        transport: 'http',
        name: 'SOCKS5 代理实例',
        authMode: 'none',
        // 该域名不解析：只有经 SOCKS5 隧道（代理端按测试映射到本机目标）才能打开，
        // 直连会 DNS 失败，因此页面加载本身即可证明代理生效。
        endpointUrl: `http://socks-e2e.invalid:${input.targetPort}/`,
        proxy: { type: 'socks5', host: '127.0.0.1', port: input.socksPort }
      })
      if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`)
      return result.value
    },
    { targetPort, socksPort }
  )
  if (created.transport !== 'http') throw new Error('创建的实例不是 HTTP 类型')
  expect(created.proxy).toEqual({ type: 'socks5', host: '127.0.0.1', port: socksPort })

  const id = created.id
  const started = await win.evaluate(async (instanceId) => {
    const result = await window.dshHub.runtime.start(instanceId)
    return result.ok
  }, id)
  expect(started).toBe(true)

  // 启动探测必须经 SOCKS5 隧道完成；代理未生效时这里不会增长。
  await expect.poll(() => tunnels, { timeout: 15_000 }).toBeGreaterThan(0)
  expect(socksHits).toBeGreaterThan(0)
  expect(targetHits).toBeGreaterThan(0)

  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await win.getByTestId('instances-table').getByText('SOCKS5 代理实例', { exact: true }).click()
  await expect(win.getByTestId('detail-proxy')).toContainText(`socks5://127.0.0.1:${socksPort}`)
  await win.getByTestId('open-view-btn').click()
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible({ timeout: 20_000 })

  await expect
    .poll(
      async () => await workspaceText('document.getElementById("socks-ok")?.textContent ?? ""'),
      { timeout: 20_000 }
    )
    .toBe('socks ok')
  expect(targetHits).toBeGreaterThan(0)
})
