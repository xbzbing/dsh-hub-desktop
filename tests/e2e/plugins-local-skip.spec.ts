import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eDataDir } from './data-dir'
import {
  LOCAL_PLUGIN_VERSION,
  launchPluginApp,
  openDetail,
  seedInstance,
  seedPluginFixture
} from './plugins-fixture'

/**
 * 本地/GitHub 安装的插件不参与 npm 更新检查：行内检查按钮保持可见但禁用，
 * 悬停说明原因；一键检查跳过它们。
 *
 * 假 dsh 的本地插件在 list 里报 `file:` 安装说明，真实版本来自本地包清单。
 */
const DATA_DIR = e2eDataDir('e2e-plugins-local-skip')

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  await seedPluginFixture(DATA_DIR)
  const launched = await launchPluginApp(DATA_DIR, { DSH_E2E_PLUGIN_LOCAL: '1' })
  app = launched.app
  win = launched.win
  await seedInstance(win, DATA_DIR)
})

test.afterAll(async () => {
  await app.close()
  await rm(DATA_DIR, { recursive: true, force: true })
})

test('本地安装的插件：检查按钮禁用并说明原因，一键检查跳过', async () => {
  test.setTimeout(90_000)
  await openDetail(win)

  const row = win.getByTestId('plugin-row-local-plugin')
  await expect(row).toBeVisible({ timeout: 15_000 })
  // 版本取本地 package.json，不把 file: 安装说明当版本展示。
  await expect(row).toContainText(LOCAL_PLUGIN_VERSION)

  // 详情显示本地安装目录与工作树的 GitHub 仓库地址；未确认发布到 npm 时不显示 npm 地址。
  await win.getByTestId('plugin-expand-local-plugin').click()
  const detail = win.getByTestId('plugin-detail-local-plugin')
  await expect(detail.getByTestId('plugin-install-dir-local-plugin')).toContainText(
    join(DATA_DIR, 'fake-plugin-local')
  )
  await expect(detail.getByTestId('plugin-github-link-local-plugin')).toHaveText(
    'https://github.com/demo/local-plugin-git'
  )
  await expect(detail.getByTestId('plugin-npm-link-local-plugin')).toHaveCount(0)
  // 本地插件不可检查 npm 更新，不展示「点检查升级获取」的发布时间占位。
  await expect(detail).not.toContainText('点检查升级获取')

  // 按钮仍在原位（与 npm 插件同一列），只是禁用。
  const check = win.getByTestId('plugin-check-local-plugin')
  await expect(check).toBeVisible()
  await expect(check).toContainText('检查升级')
  await expect(check).toBeDisabled()

  // 悬停说明原因：禁用按钮本身不派发指针事件，气泡挂在包裹层上。
  const bubble = win.locator('.info-tip').filter({ has: check }).locator('.info-tip-bubble')
  await expect(bubble).toHaveText('本地/GitHub 安装的插件不支持检查 npm 更新')
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('0')
  await check.hover()
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  await win.mouse.move(4, 4)

  // 一键检查：npm 插件被检查（出现升级按钮），本地插件被跳过、不产生任何检查结论。
  await win.getByTestId('plugins-check-all-btn').click()
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toBeVisible({ timeout: 30_000 })
  await expect(win.getByTestId(`plugin-uptodate-local-plugin`)).toHaveCount(0)
  await expect(win.getByTestId(`plugin-check-error-local-plugin`)).toHaveCount(0)
  await expect(check).toBeDisabled()
  await expect(check).not.toContainText('检查中')
})
