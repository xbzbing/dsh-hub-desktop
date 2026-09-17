import { spawn, type ChildProcess } from 'node:child_process'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 外部 dsh web 的 E2E 验证：
 * - HTTP 实例无需启动即可打开视图
 * - 可探测并接管本机已运行的 dsh web，然后直接开窗
 *
 * 假 dsh web:用 `node -e` 起一个**监听端口的进程**,并让它的命令行包含
 * `dsh web --patch <file>`(探测器按命令行识别,不依赖真实 dsh 安装)。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-external')
const SHOT_DIR = resolve(__dirname, '..', '..', 'hub-data', 'ui-polish-shots')
const REMOTE_GATEWAY = 'https://dsh.crazydb.com/'

let app: ElectronApplication
let win: Page
let fakeDsh: ChildProcess | null = null

const launchArgs = ['.']
if (process.env.CI) launchArgs.push('--no-sandbox')
for (const arg of (process.env.DSH_HUB_E2E_ARGS ?? '').split(' ').filter(Boolean)) {
  launchArgs.push(arg)
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })

  const script = [
    "const http = require('node:http')",
    "http.createServer((_, res) => res.end('<html><body><h1 id=\"external-dsh\">外部 dsh web</h1></body></html>'))",
    ".listen(0, '127.0.0.1', function () { console.log(this.address().port); setTimeout(() => {}, 600000) })"
  ].join('\n')
  fakeDsh = spawn(
    process.execPath,
    ['-e', script, '/tmp/fake-dsh/dsh', 'web', '--patch', '/tmp/fake-dsh/cordis.dush.patch.yml', '--no-open'],
    { stdio: ['ignore', 'pipe', 'ignore'], detached: false }
  )
  await new Promise<void>((resolvePromise, reject) => {
    fakeDsh?.once('error', reject)
    fakeDsh?.stdout?.once('data', () => resolvePromise())
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
})

test('远程网关登录重定向不把正常 ERR_FAILED 写入主进程错误日志', async () => {
  const mainErrors: string[] = []
  const onOutput = (chunk: Buffer): void => {
    mainErrors.push(String(chunk))
  }
  app.process().stderr?.on('data', onOutput)
  app.process().stdout?.on('data', onOutput)
  try {
    const created = await win.evaluate(async (endpointUrl) => {
      const r = await window.dshHub.instances.create({
        transport: 'http',
        name: '远程登录重定向',
        authMode: 'gateway',
        endpointUrl
      })
      return r.ok ? r.value.id : null
    }, REMOTE_GATEWAY)
    expect(created).not.toBeNull()
    if (!created) return

    await win.reload()
    await expect(win.getByTestId('app-shell')).toBeVisible()
    await win.getByTestId('instances-table').getByText('远程登录重定向', { exact: true }).click()
    await expect(win.getByTestId('open-view-btn')).toBeEnabled()
    await win.getByTestId('open-view-btn').click()
    await expect.poll(async () =>
      app.evaluate(({ BrowserWindow }) => {
        const workspace = BrowserWindow.getAllWindows()[0]?.contentView.children[0] as
          | { webContents?: { getURL(): string } }
          | undefined
        return workspace?.webContents?.getURL() ?? ''
      })
    ).toContain('/login')
    await win.getByRole('button', { name: '关闭' }).click()
    await win.waitForTimeout(300)
    const log = mainErrors.join('')
    expect(log).not.toContain('[instance-view] 加载失败')
    expect(log).not.toContain("ERR_FAILED (-2) loading 'https://dsh.crazydb.com/'")
  } finally {
    app.process().stderr?.off('data', onOutput)
    app.process().stdout?.off('data', onOutput)
  }
})

test('HTTP 实例未启动也能直接打开视图', async () => {
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
  await win.getByTestId('instances-table').getByText('免启动 http', { exact: true }).click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // 关键:没有点过「启动」,开窗按钮必须可用
  const openBtn = win.getByTestId('open-view-btn')
  await expect(openBtn).toBeEnabled()
  await win.screenshot({ path: join(SHOT_DIR, 'http-open-without-start.png'), animations: 'disabled' })
})

test('探测到已运行的 dsh web 后可接管并直接开窗', async () => {
  // 接管和断开都不应产生运行信息回写错误。
  const mainErrors: string[] = []
  app.process().stderr?.on('data', (chunk: Buffer) => mainErrors.push(String(chunk)))
  app.process().stdout?.on('data', (chunk: Buffer) => mainErrors.push(String(chunk)))

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
  await win.getByTestId('instances-table').getByText('接管本地实例', { exact: true }).click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // 详情页出现「本机已在运行的 dsh web」卡片(只读探测命中假 dsh web)
  const card = win.getByTestId('external-dsh-card')
  await expect(card).toBeVisible({ timeout: 10_000 })
  await win.screenshot({ path: join(SHOT_DIR, 'external-dsh-detected.png'), animations: 'disabled' })

  await card.locator('[data-testid^="external-access-"]').first().fill('external-token')
  await card.locator('[data-testid^="adopt-btn-"]:not([disabled])').click()
  await expect(win.getByTestId('open-view-btn')).toBeEnabled()
  await win.getByTestId('open-view-btn').click()
  await expect.poll(async () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.contentView.children.map((child) =>
        (child as { webContents?: { getURL(): string } }).webContents?.getURL() ?? ''
      ) ?? []
    )
  ).toContainEqual(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+/))
  expect(fakeDsh?.killed).toBe(false)

  // 接管和断开都不应产生运行信息回写错误。
  await win.waitForTimeout(300)
  const log = mainErrors.join('')
  expect(log).not.toContain('回写实例运行信息失败')
  expect(log).not.toContain('补丁不能为空')
})
