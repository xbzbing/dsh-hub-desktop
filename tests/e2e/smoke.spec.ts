import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * 应用冒烟：窗口渲染真实外壳、preload 白名单 API 形状、空数据目录展示空态、
 * 主进程版本信息可达。前置：`pnpm build`。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-smoke')

let app: ElectronApplication
let win: Page

const launchArgs = ['.']
if (process.env.CI) launchArgs.push('--no-sandbox')
for (const arg of (process.env.DSH_HUB_E2E_ARGS ?? '').split(' ').filter(Boolean)) {
  launchArgs.push(arg)
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test('窗口打开并渲染出应用外壳', async () => {
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await expect(win.getByTestId('brand')).toBeVisible()
  await expect(win.getByTestId('sidebar')).toBeVisible()
})

test('preload 白名单桥接形状正确(无多余暴露)', async () => {
  const api = await win.evaluate(() => (window.dshHub ? Object.keys(window.dshHub).sort() : null))
  // T5 起新增 ssh 组(密钥预览/指纹确认/口令输入);任何额外暴露都会让本用例失败
  expect(api).toEqual(['getInfo', 'http', 'instances', 'onInstanceStatus', 'ping', 'runtime', 'ssh'].sort())
  const sshKeys = await win.evaluate(() =>
    window.dshHub?.ssh ? Object.keys(window.dshHub.ssh).sort() : null
  )
  expect(sshKeys).toEqual(
    [
      'keyPreview',
      'onAskpassRequest',
      'onHostKeyDecision',
      'replyAskpass',
      'replyHostKey'
    ].sort()
  )
  const httpKeys = await win.evaluate(() =>
    window.dshHub?.http ? Object.keys(window.dshHub.http).sort() : null
  )
  expect(httpKeys).toEqual(['detect'])
})

test('空数据目录展示空态(真实注册表后端)', async () => {
  await expect(win.getByTestId('view-empty')).toBeVisible()
  await expect(win.getByTestId('empty-new-btn')).toBeVisible()
})

test('主进程版本信息可经桥接读取', async () => {
  const info = await win.evaluate(async () => window.dshHub.getInfo())
  expect(info.ok).toBe(true)
  if (info.ok) {
    expect(info.value.electron).toMatch(/^\d+\.\d+\.\d+/)
    expect(info.value.platform).not.toBe('')
  }
})