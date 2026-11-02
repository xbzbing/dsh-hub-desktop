import { createServer, type Server } from 'node:http'
import { rm } from 'node:fs/promises'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'

/**
 * 页内查找走真实工作区：Hub 顶栏的查找条通过 WebContents.findInPage 搜索
 * 主进程 WebContentsView 中的页面，命中数经 found-in-page 回推到渲染层。
 */
const DATA_DIR = e2eDataDir('e2e-find-in-page')

let app: ElectronApplication
let win: Page
let server: Server
let port = 0

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><html><head><title>find target</title></head><body>' +
        '<p>needle alpha</p><p>needle beta</p><p>third line</p>' +
        '</body></html>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
  app = await electron.launch({ args: buildLaunchArgs(), env: e2eEnv(DATA_DIR) })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(DATA_DIR, { recursive: true, force: true })
})

test('顶栏查找条搜索当前工作区并循环匹配', async () => {
  test.setTimeout(120_000)
  const created = await win.evaluate(async (endpointPort) => {
    const r = await window.dshHub.instances.create({
      transport: 'http',
      name: '页内查找实例',
      authMode: 'none',
      endpointUrl: `http://127.0.0.1:${endpointPort}/`
    })
    if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r)}`)
    const s = await window.dshHub.runtime.start(r.value.id)
    return { id: r.value.id, startOk: s.ok }
  }, port)
  expect(created.startOk).toBe(true)

  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await win.getByTestId('instances-table').getByText('页内查找实例', { exact: true }).click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await win.getByTestId('open-view-btn').click()
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible({ timeout: 20_000 })

  // 菜单入口：走真实 MenuItem，只命中 id=workspace-find 的项。
  await app.evaluate(({ Menu }) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === 'workspace-find') return item
        const found = item.submenu ? walk(item.submenu.items) : null
        if (found) return found
      }
      return null
    }
    walk(Menu.getApplicationMenu()?.items ?? [])?.click()
  })
  const bar = win.getByTestId('workspace-find')
  const input = win.getByTestId('workspace-find-input')
  await expect(bar).toBeVisible()
  await expect(input).toBeFocused()
  await input.fill('needle')
  await expect(win.getByTestId('workspace-find-count')).toHaveText('1/2', { timeout: 10_000 })

  await input.press('Enter')
  await expect(win.getByTestId('workspace-find-count')).toHaveText('2/2')
  await input.press('Shift+Enter')
  await expect(win.getByTestId('workspace-find-count')).toHaveText('1/2')
  await input.fill('not-present')
  await expect(win.getByTestId('workspace-find-count')).toHaveText('无结果')
  await input.press('Escape')
  await expect(bar).toBeHidden()

  // 键盘入口：工作区打开时 ⌘/Ctrl+F 也能直接打开查找条。
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+F' : 'Control+F')
  await expect(bar).toBeVisible()
  await expect(input).toBeFocused()
  await win.keyboard.press('Escape')
  await expect(bar).toBeHidden()
})
