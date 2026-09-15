import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * T1 冒烟（R4 端到端测试基线）：以真实 Electron 二进制 + 已构建产物启动应用，
 * 验证 窗口渲染 / IPC 全链路 / 主进程存活 三条冒烟路径。
 * 前置：`pnpm build`（_electron 入口为 package.json 的 main → out/main/index.js）。
 */

let app: ElectronApplication
let win: Page

// CI（无显示器的 Linux）需要 xvfb + 无沙箱；本机受限环境可通过 DSH_HUB_E2E_ARGS 注入
const launchArgs = ['.']
if (process.env.CI) launchArgs.push('--no-sandbox')
for (const arg of (process.env.DSH_HUB_E2E_ARGS ?? '').split(' ').filter(Boolean)) {
  launchArgs.push(arg)
}

const launchEnv = {
  ...process.env,
  // 应用数据隔离到工作区 hub-data/e2e（.gitignore 已忽略），不触碰真实 userData
  DSH_HUB_DATA_DIR: resolve(__dirname, '..', '..', 'hub-data', 'e2e')
}

test.beforeAll(async () => {
  app = await electron.launch({ args: launchArgs, env: launchEnv })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test('窗口打开并渲染出 T1 骨架', async () => {
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await expect(win.getByRole('heading', { name: /骨架就绪/ })).toBeVisible()
})

test('主进程信息经 preload 桥接到达渲染进程', async () => {
  const versions = win.getByTestId('versions')
  await expect(versions).toBeVisible()
  await expect(versions).toContainText('electron ')
  await expect(versions).toContainText('chrome ')
  await expect(versions).toContainText('node ')
})

test('ping 通道双向可达', async () => {
  await win.getByTestId('ping-button').click()
  await expect(win.getByTestId('pong-status')).toContainText('echo=hello from renderer')
})

test('主进程版本号与渲染进程展示一致', async () => {
  const mainVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion())
  const rendered = await win.getByTestId('versions').textContent()
  expect(rendered).toContain(`app ${mainVersion}`)
})