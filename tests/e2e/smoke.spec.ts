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
  // T5 起新增 ssh 组;T10 起新增 vault 组;T11 起新增 settings 组;
  // **T12 评审修复**新增 `ssh.forgetHostKey`(显式遗忘主机指纹)与
  // `settings.openDataDir`(打开数据目录);任何额外暴露都会让本用例失败
  expect(api).toEqual(
    [
      'auth',
      'getInfo',
      'http',
      'instances',
      'onInstanceStatus',
      'ping',
      'runtime',
      'settings',
      'ssh',
      'vault'
    ].sort()
  )
  const sshKeys = await win.evaluate(() =>
    window.dshHub?.ssh ? Object.keys(window.dshHub.ssh).sort() : null
  )
  expect(sshKeys).toEqual(
    [
      'keyPreview',
      'onAskpassRequest',
      'onHostKeyDecision',
      'replyAskpass',
      'replyHostKey',
      // 设计 §7.3「指纹变更一律拒绝连接(不自动清理)」的**唯一**恢复入口:
      // 用户显式遗忘本机为该主机保存的指纹,下次连接重新 TOFU。
      // 这是破坏性动作,但没有它就无法从「主机合法换钥」中恢复。
      'forgetHostKey'
    ].sort()
  )
  const httpKeys = await win.evaluate(() =>
    window.dshHub?.http ? Object.keys(window.dshHub.http).sort() : null
  )
  expect(httpKeys).toEqual(['detect'])
  const authKeys = await win.evaluate(() =>
    window.dshHub?.auth ? Object.keys(window.dshHub.auth).sort() : null
  )
  // T8 G2 新增 loginStored:密码不跨 IPC(渲染层只传实例 id 与可选 OTP,
  // 主进程自取 vault 已存密码)—— 白名单多暴露任何一个都会让本用例失败
  expect(authKeys).toEqual(['login', 'loginStored', 'logout', 'onSignal', 'onState', 'probe'])
  // T10 凭据保险库:只暴露状态/勾选/忘记/清空 —— 没有「读出凭据」的通道
  const vaultKeys = await win.evaluate(() =>
    window.dshHub?.vault ? Object.keys(window.dshHub.vault).sort() : null
  )
  expect(vaultKeys).toEqual(['clear', 'forget', 'setPolicy', 'status'])
  // T11 应用设置:只暴露 get/update;T12 增补 openDataDir —— **签名不带任何参数**,
  // 目录由主进程自行解析,渲染层无法指定路径(见 shell/open-data-dir.ts)
  const settingsKeys = await win.evaluate(() =>
    window.dshHub?.settings ? Object.keys(window.dshHub.settings).sort() : null
  )
  expect(settingsKeys).toEqual(['get', 'openDataDir', 'update'])
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