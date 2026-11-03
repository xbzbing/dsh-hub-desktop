import { createServer, type Server } from 'node:http'
import { rm } from 'node:fs/promises'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'

/**
 * 页内查找走真实工作区：Hub 顶栏的查找条通过 WebContents.findInPage 搜索
 * 主进程 WebContentsView 中的页面，命中数经 found-in-page 回推到渲染层。
 * 页面自己处理 ⌘/Ctrl+F 时由页面优先响应，Hub 不拦截。
 */
const DATA_DIR = e2eDataDir('e2e-find-in-page')

let app: ElectronApplication
let win: Page
let server: Server
let port = 0

/** 工作区页面：`/handles` 自己消费 ⌘/Ctrl+F，根路径不处理。 */
function pageMarkup(handles: boolean): string {
  return (
    '<!doctype html><html><head><title>find target</title></head><body>' +
    '<p>needle alpha</p><p>needle beta</p><p>third line</p>' +
    '<script>' +
    'window.__keys = [];' +
    'window.addEventListener("keydown", (event) => {' +
    '  const find = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f";' +
    (handles ? '  if (find) event.preventDefault();' : '') +
    '  window.__keys.push({ key: event.key, code: event.code, meta: event.metaKey, ctrl: event.ctrlKey, prevented: event.defaultPrevented });' +
    '});' +
    '</script>' +
    '</body></html>'
  )
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(pageMarkup(request.url === '/handles'))
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

test('顶栏查找条搜索当前工作区并循环匹配，页面自行处理快捷键时让位', async () => {
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

  // 菜单入口：走真实 MenuItem，只命中 id=workspace-find 的项，并确认兜底快捷键仍挂在菜单上。
  const accelerator = await app.evaluate(({ Menu }) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (item.id === 'workspace-find') return item
        const found = item.submenu ? walk(item.submenu.items) : null
        if (found) return found
      }
      return null
    }
    const item = walk(Menu.getApplicationMenu()?.items ?? [])
    item?.click()
    return item?.accelerator ?? null
  })
  expect(accelerator).toBe('CmdOrCtrl+F')
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

  // 原生视图持焦时按键先交给页面：页面自己 preventDefault 的快捷键不会被 Hub 抢走。
  const isMac = process.platform === 'darwin'
  await app.evaluate(async (_electron, targetUrl) => {
    const area = (view: { getBounds?: () => { width: number; height: number } }): number => {
      const bounds = view.getBounds?.()
      return (bounds?.width ?? 0) * (bounds?.height ?? 0)
    }
    const host = _electron.BrowserWindow.getAllWindows().find(
      (candidate) => candidate.contentView.children.length > 0
    )
    const target = (host?.contentView.children ?? [])
      .map(
        (child) =>
          child as {
            getBounds?: () => { width: number; height: number }
            webContents?: {
              focus: () => void
              loadURL: (url: string) => Promise<void>
            }
          }
      )
      .filter((child) => child.webContents !== undefined)
      .sort((a, b) => area(b) - area(a))[0]
    if (!target?.webContents) throw new Error('工作区视图不存在')
    await target.webContents.loadURL(targetUrl)
    target.webContents.focus()
  }, `http://127.0.0.1:${port}/handles`)

  const received = (await app.evaluate(
    async (_electron, modifiers) => {
      const area = (view: { getBounds?: () => { width: number; height: number } }): number => {
        const bounds = view.getBounds?.()
        return (bounds?.width ?? 0) * (bounds?.height ?? 0)
      }
      const host = _electron.BrowserWindow.getAllWindows().find(
        (candidate) => candidate.contentView.children.length > 0
      )
      const target = (host?.contentView.children ?? [])
        .map(
          (child) =>
            child as {
              getBounds?: () => { width: number; height: number }
              webContents?: {
                focus: () => void
                sendInputEvent: (event: unknown) => void
                executeJavaScript: (code: string) => Promise<unknown>
              }
            }
        )
        .filter((child) => child.webContents !== undefined)
        .sort((a, b) => area(b) - area(a))[0]
      if (!target?.webContents) throw new Error('工作区视图不存在')
      target.webContents.focus()
      target.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: 'f',
        modifiers: [modifiers]
      })
      target.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'f', modifiers: [modifiers] })
      await new Promise((resolve) => setTimeout(resolve, 500))
      return target.webContents.executeJavaScript('window.__keys')
    },
    isMac ? 'meta' : 'control'
  )) as Array<{
    key: string
    code: string
    meta: boolean
    ctrl: boolean
    prevented: boolean
  }>

  expect(received).toEqual([{ key: 'f', code: 'KeyF', meta: isMac, ctrl: !isMac, prevented: true }])
  await expect(bar).toBeHidden()
})
