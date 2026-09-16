import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * T3 渲染层端到端:空态 → 向导三步创建 → 表格/侧栏 → 详情 → 删除闭环。
 * 说明:本地分支创建后会自动触发启动,在受限/CI 环境里安装可能失败,但本用例
 * 只断言 UI 与注册表结果,启动结果由 status 事件另行覆盖(见 local-runtime 单测)。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-ui')

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

test('空态 → 向导三步创建本地实例 → 表格与侧栏可见', async () => {
  await expect(win.getByTestId('view-empty')).toBeVisible()
  await win.getByTestId('empty-new-btn').click()

  // 第 1 步:连接方式(默认本地)
  await expect(win.getByTestId('wizard')).toBeVisible()
  await expect(win.getByTestId('type-local')).toHaveAttribute('aria-pressed', 'true')
  await win.getByRole('button', { name: '下一步' }).click()

  // 第 2 步:配置
  await expect(win.getByTestId('wizard-step-2')).toBeVisible()
  await win.getByTestId('wizard-name').fill('E2E 演示实例')
  await win.getByRole('button', { name: '下一步' }).click()

  // 第 3 步:确认并创建
  await expect(win.getByTestId('wizard-step-3')).toBeVisible()
  await expect(win.getByText('E2E 演示实例')).toBeVisible()
  await win.getByTestId('wizard-create').click()

  // 向导关闭,回到总览表格
  await expect(win.getByTestId('wizard')).toBeHidden()
  await expect(win.getByTestId('view-home')).toBeVisible()
  const table = win.getByTestId('instances-table')
  await expect(table).toContainText('E2E 演示实例')
  await expect(table).toContainText('本地')
})

test('详情页展示连接方式,删除后回到空态', async () => {
  await expect(win.getByTestId('instances-table')).toBeVisible()
  const firstSidebarItem = win.locator('[data-testid^="inst-"]').first()

  // 侧栏选择 → 详情
  await firstSidebarItem.click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByText('连接方式')).toBeVisible()
  await expect(win.getByText('运行环境')).toBeVisible()
  await expect(win.getByTestId('open-view-btn')).toContainText('打开工作区')

  // 删除(二次确认)→ 回空态
  await win.getByTestId('delete-btn').click()
  await expect(win.getByTestId('confirm-delete')).toBeVisible()
  await win.getByRole('button', { name: '删除', exact: true }).click()
  await expect(win.getByTestId('view-empty')).toBeVisible()
})