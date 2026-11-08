import { _electron as electron, expect, test } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import type { AppUpdateCheck } from '@shared/bridge'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'

/**
 * 设置页「检查更新」的结果位置与更新说明对话框。
 *
 * 真实检查依赖外网与线上 Release 内容，这里用固定应答替换主进程的
 * `app:check-update` 处理器，只验证界面：结果与按钮同一行，有更新时弹对话框。
 */

const DATA_DIR = e2eDataDir('e2e-check-update-dialog')

const UPDATE: AppUpdateCheck = {
  current: '0.1.9',
  latest: '0.1.10',
  hasUpdate: true,
  releaseUrl: 'https://github.com/xbzbing/dsh-hub-desktop/releases/tag/v0.1.10',
  publishedAt: '2026-11-04T03:47:56Z',
  notes: '# DSH Hub v0.1.10\n\n## 亮点\n\n- 对话框内容：检查更新的结果紧跟按钮右侧\n',
  checkedAt: '2026-11-09T00:00:00.000Z'
}

const UP_TO_DATE: AppUpdateCheck = {
  ...UPDATE,
  latest: '0.1.9',
  hasUpdate: false,
  notes: null
}

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  app = await electron.launch({
    args: buildLaunchArgs(),
    env: e2eEnv(DATA_DIR)
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

/** 替换主进程的检查实现：IPC 通道名与 preload 使用的一致。 */
async function stubCheck(value: AppUpdateCheck): Promise<void> {
  await app.evaluate(({ ipcMain }, payload) => {
    ipcMain.removeHandler('app:check-update')
    ipcMain.handle('app:check-update', () => ({ ok: true, value: payload }))
  }, value)
}

async function check(): Promise<void> {
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await win.getByTestId('settings-btn').click()
  await expect(win.getByTestId('view-settings')).toBeVisible()
  await win.getByTestId('settings-check-update').click()
  await expect(win.getByTestId('settings-update-result')).toBeVisible({ timeout: 15_000 })
}

test('有更新：结果与按钮同一行，并弹出显示版本与更新内容的对话框', async () => {
  await stubCheck(UPDATE)
  await check()

  // 结果在「检查更新」按钮右侧，而不是下侧：两者同属一个行容器。
  const sameRow = await win.evaluate(() => {
    const button = document.querySelector('[data-testid="settings-check-update"]')
    const result = document.querySelector('[data-testid="settings-update-result"]')
    return button !== null && result !== null && button.parentElement === result.parentElement
  })
  expect(sameRow).toBe(true)
  await expect(win.getByTestId('settings-update-verdict')).toContainText('0.1.10')

  const dialog = win.getByTestId('update-available-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('发现新版本 v0.1.10')
  await expect(dialog).toContainText('当前版本 v0.1.9')
  // 正文按 Markdown 渲染；首个一级标题与对话框标题重复，已去掉。
  await expect(win.getByTestId('update-dialog-notes')).toContainText('对话框内容')
  await expect(win.getByTestId('update-dialog-notes')).not.toContainText('# DSH Hub')

  await win.getByTestId('update-dialog-close').click()
  await expect(dialog).toBeHidden()
  // 关闭对话框不影响按钮右侧的结果。
  await expect(win.getByTestId('settings-update-verdict')).toContainText('0.1.10')
})

test('已是最新：只留行内结果，不弹对话框', async () => {
  await stubCheck(UP_TO_DATE)
  await check()

  await expect(win.getByTestId('settings-update-verdict')).toContainText(/已是最新|up to date/)
  await expect(win.getByTestId('update-available-dialog')).toHaveCount(0)
  await expect(win.getByTestId('settings-open-release')).toHaveCount(0)
})
