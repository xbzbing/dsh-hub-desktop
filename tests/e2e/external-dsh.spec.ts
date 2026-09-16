import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 实机反馈(2026-09-16)E2E 验证:
 * - #1 非本地实例(http)不必先「启动」就能打开视图(启动的意义就是开窗)
 * - #2 本机已在运行的 dsh web 能被探测到、并被「接管」后直接开窗
 *
 * 假 dsh web:用 `node -e` 起一个**监听端口的进程**,并让它的命令行包含
 * `dsh web --patch <file>`(探测器按命令行识别,不依赖真实 dsh 安装)。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-external')
const SHOT_DIR = resolve(__dirname, '..', '..', 'hub-data', 'ui-polish-shots')

let app: ElectronApplication
let win: Page
let fakeDsh: ChildProcess | null = null
let fakeServer: Server | null = null

const launchArgs = ['.']
if (process.env.CI) launchArgs.push('--no-sandbox')
for (const arg of (process.env.DSH_HUB_E2E_ARGS ?? '').split(' ').filter(Boolean)) {
  launchArgs.push(arg)
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })

  // 假 dsh web:监听 127.0.0.1 的随机端口,命令行带 `dsh web --patch …`
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body><h1 id="external-dsh">外部 dsh web</h1></body></html>')
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  fakeServer = server
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const script = `require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1',()=>setTimeout(()=>{},600000))`
  fakeDsh = spawn(process.execPath, ['-e', script, '/tmp/fake-dsh/dsh', 'web', '--patch', '/tmp/fake-dsh/cordis.dush.patch.yml', '--no-open', '--port', String(port)], {
    stdio: 'ignore',
    detached: false
  })

  app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()
  await expect(win.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  fakeDsh?.kill('SIGTERM')
  fakeServer?.close()
})

test('实机 #1:http 实例未启动也能直接打开视图', async () => {
  const created = await win.evaluate(async () => {
    const r = await window.dshHub.instances.create({
      transport: 'http',
      name: '免启动 http',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })
    return r.ok ? r.value.id : null
  })
  expect(created).not.toBeNull()
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await win.getByTestId(`inst-${created}`).click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // 关键:没有点过「启动」,开窗按钮必须可用
  const openBtn = win.getByTestId('open-view-btn')
  await expect(openBtn).toBeEnabled()
  await win.screenshot({ path: join(SHOT_DIR, 'http-open-without-start.png'), animations: 'disabled' })
})

test('实机 #2:探测到已在运行的 dsh web → 一键接管 → 可直接开窗', async () => {
  const created = await win.evaluate(async () => {
    const r = await window.dshHub.instances.create({
      transport: 'local',
      name: '接管本地实例',
      authMode: 'auto'
    })
    return r.ok ? r.value.id : null
  })
  expect(created).not.toBeNull()
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await win.getByTestId(`inst-${created}`).click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // 详情页出现「本机已在运行的 dsh web」卡片(只读探测命中假 dsh web)
  const card = win.getByTestId('external-dsh-card')
  await expect(card).toBeVisible({ timeout: 10_000 })
  await win.screenshot({ path: join(SHOT_DIR, 'external-dsh-detected.png'), animations: 'disabled' })

  // 接管:点第一个接管按钮
  const adoptBtn = card.locator('[data-testid^="adopt-btn-"]').first()
  await adoptBtn.click()
  // 接管成功后运行状态变为 connected(开窗解锁、启动按钮变停止)
  await expect(win.getByTestId('stop-btn')).toBeVisible({ timeout: 10_000 })
  await expect(win.getByTestId('open-view-btn')).toBeEnabled()
  await win.screenshot({ path: join(SHOT_DIR, 'external-dsh-adopted.png'), animations: 'disabled' })

  // 停止 = 只断开接管,不杀外部进程(卡片应重新出现,外部进程仍在)
  await win.getByTestId('stop-btn').click()
  await expect(win.getByTestId('external-dsh-card')).toBeVisible({ timeout: 10_000 })
  expect(fakeDsh?.killed).toBe(false)
})
