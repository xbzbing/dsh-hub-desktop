import { createServer, type Server } from 'node:http'
import { rm } from 'node:fs/promises'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import { pickOption } from './select'

/**
 * 远程 HTTP 实例经代理访问：
 * - 创建时写入的代理密码只进 vault，记录里没有密码；
 * - 健康探测与页面加载都走实例分区上的代理，代理要求 Basic 认证时用 vault 密码重试；
 * - 清空代理后回到直连。
 */
const DATA_DIR = e2eDataDir('e2e-http-proxy')
const PROXY_USER = 'proxy-e2e'
const PROXY_PASSWORD = 'proxy-secret'
const EXPECTED_AUTH = `Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString('base64')}`
const PROXY_PAGE =
  '<!doctype html><html><head><title>proxy target</title></head><body><h1 id="proxy-ok">proxy ok</h1></body></html>'
const DIRECT_PAGE =
  '<!doctype html><html><head><title>direct target</title></head><body><h1 id="direct-ok">direct ok</h1></body></html>'

let app: ElectronApplication
let win: Page
let target: Server
let proxy: Server
let targetPort = 0
let proxyPort = 0
let targetHits = 0
let proxyHits = 0
let authorizedHits = 0

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
    response.end(DIRECT_PAGE)
  })
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  const targetAddress = target.address()
  targetPort = typeof targetAddress === 'object' && targetAddress ? targetAddress.port : 0

  proxy = createServer((request, response) => {
    proxyHits += 1
    if (request.headers['proxy-authorization'] !== EXPECTED_AUTH) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="e2e"' })
      response.end()
      return
    }
    authorizedHits += 1
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PROXY_PAGE)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyAddress = proxy.address()
  proxyPort = typeof proxyAddress === 'object' && proxyAddress ? proxyAddress.port : 0

  app = await electron.launch({ args: buildLaunchArgs(), env: e2eEnv(DATA_DIR) })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
  await new Promise<void>((resolve) => target.close(() => resolve()))
  await new Promise<void>((resolve) => proxy.close(() => resolve()))
  await rm(DATA_DIR, { recursive: true, force: true })
})

test('HTTP 实例经认证代理启动、打开，清空代理后直连', async () => {
  test.setTimeout(180_000)
  const created = await win.evaluate(
    async ({ proxyPort: port, targetPort: destinationPort }) => {
      const result = await window.dshHub.instances.create({
        transport: 'http',
        name: '代理实例',
        authMode: 'none',
        endpointUrl: `http://127.0.0.1:${destinationPort}/`,
        proxy: {
          type: 'http',
          host: '127.0.0.1',
          port,
          username: 'proxy-e2e',
          password: 'proxy-secret'
        }
      })
      if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`)
      return result.value
    },
    { proxyPort, targetPort }
  )
  if (created.transport !== 'http') throw new Error('创建的实例不是 HTTP 类型')
  expect(created.proxy).toEqual({
    type: 'http',
    host: '127.0.0.1',
    port: proxyPort,
    username: PROXY_USER
  })
  expect(JSON.stringify(created)).not.toContain(PROXY_PASSWORD)

  const id = created.id
  const started = await win.evaluate(async (instanceId) => {
    const result = await window.dshHub.runtime.start(instanceId)
    return result.ok
  }, id)
  expect(started).toBe(true)
  // start 返回与首次健康探测完成的先后不作保证，等代理侧实际收到带凭据的请求。
  await expect.poll(() => authorizedHits, { timeout: 15_000 }).toBeGreaterThan(0)
  expect(proxyHits).toBeGreaterThan(0)
  expect(targetHits).toBe(0)

  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await win.getByTestId('instances-table').getByText('代理实例', { exact: true }).click()
  await expect(win.getByTestId('detail-proxy')).toContainText(`http://127.0.0.1:${proxyPort}`)
  await win.getByTestId('open-view-btn').click()
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible({ timeout: 20_000 })

  await expect
    .poll(
      async () => {
        return await workspaceText('document.getElementById("proxy-ok")?.textContent ?? ""')
      },
      { timeout: 20_000 }
    )
    .toBe('proxy ok')
  expect(targetHits).toBe(0)

  await win.getByTestId('workspace-back-btn').click()
  await expect(win.getByTestId('detail-proxy')).toContainText(`http://127.0.0.1:${proxyPort}`)
  await win.getByTestId('edit-btn').click()
  await expect(win.getByTestId('edit-dialog')).toBeVisible()
  await expect(win.getByTestId('edit-proxy-host')).toHaveValue('127.0.0.1')
  await expect(win.getByTestId('edit-proxy-port')).toHaveValue(String(proxyPort))
  await expect(win.getByTestId('edit-proxy-username')).toHaveValue(PROXY_USER)
  await pickOption(win, 'edit-proxy-type', 'none')
  await win.getByTestId('edit-save').click()
  await expect(win.getByTestId('edit-dialog')).toBeHidden()
  await expect(win.getByTestId('detail-proxy')).toContainText('直连')

  const id2 = id
  await win.evaluate(async (instanceId) => {
    await window.dshHub.runtime.stop(instanceId)
  }, id2)
  const cleared = await win.evaluate(async (instanceId) => {
    const result = await window.dshHub.instances.get(instanceId)
    return result.ok ? result.value : null
  }, id2)
  if (cleared?.transport !== 'http') throw new Error('读取的实例不是 HTTP 类型')
  expect(cleared.proxy).toBeNull()

  const restarted = await win.evaluate(async (instanceId) => {
    const result = await window.dshHub.runtime.start(instanceId)
    return result.ok
  }, id)
  expect(restarted).toBe(true)

  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  // 重载后仍停留在该实例详情页，不再经过总览表格。
  await expect(win.getByTestId('detail-proxy')).toContainText('直连')
  await win.getByTestId('open-view-btn').click()
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(
      async () => {
        return await workspaceText('document.getElementById("direct-ok")?.textContent ?? ""')
      },
      { timeout: 20_000 }
    )
    .toBe('direct ok')
  expect(targetHits).toBeGreaterThan(0)
})
