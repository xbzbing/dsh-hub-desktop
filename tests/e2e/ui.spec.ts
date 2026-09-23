import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * 渲染层端到端：空态、创建、列表、详情和删除。
 * 说明:本地分支创建后会自动触发启动,在受限/CI 环境里安装可能失败,但本用例
 * 只断言 UI 与注册表结果,启动结果由 status 事件另行覆盖(见 local-runtime 单测)。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-ui')

let app: ElectronApplication
let win: Page

const launchArgs = buildLaunchArgs()

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

  // 第 2 步:空名称先显示校验错误；输入名称后错误应立即消失。
  await expect(win.getByTestId('wizard-step-2')).toBeVisible()
  await win.getByRole('button', { name: '下一步' }).click()
  await expect(win.getByText('请填写实例名称')).toBeVisible()
  await win.getByTestId('wizard-name').fill('E2E 演示实例')
  await win.locator('[data-testid="wizard-step-2"] details.adv > summary').click()
  await expect(win.getByTestId('wizard-launcher')).toHaveValue('dsh')
  // 版本管理下拉已接线：选项首项恒为「跟随最新稳定版」（空值），与镜像拉取结果无关（离线安全）。
  await expect(win.getByTestId('wizard-version')).toBeVisible()
  await expect(win.getByTestId('wizard-version').locator('option').first()).toHaveAttribute('value', '')
  await expect(win.getByText('请填写实例名称')).toBeHidden()
  await win.getByRole('button', { name: '下一步' }).click()

  // 第 3 步:确认并创建
  await expect(win.getByTestId('wizard-step-3')).toBeVisible()
  await expect(win.getByText('E2E 演示实例')).toBeVisible()
  await win.getByTestId('wizard-create').click()

  // 创建后先展示详情；启动失败时用户仍可立即编辑本地配置。
  await expect(win.getByTestId('wizard')).toBeHidden()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByRole('heading', { name: 'E2E 演示实例' })).toBeVisible()
  await win.getByTestId('detail-overview-btn').click()
  await expect(win.getByTestId('view-home')).toBeVisible()
  const table = win.getByTestId('instances-table')
  await expect(table).toContainText('E2E 演示实例')
  await expect(table).toContainText('本地')
  const deleteFromHome = table.getByTestId(/delete-/)
  await deleteFromHome.click()
  await expect(win.getByTestId('home-confirm-delete')).toBeVisible()
  await win.getByTestId('home-confirm-delete').getByRole('button', { name: '取消' }).click()
  await expect(win.getByTestId('home-confirm-delete')).toBeHidden()
})

test('侧栏实例名称进入工作区或错误详情，随后可删除实例', async () => {
  // 确保在首页视图
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 10_000 })
  await expect(win.getByTestId('instances-table')).toBeVisible()
  const firstSidebarItem = win.locator('[data-testid^="inst-"]').first()
  await firstSidebarItem.click()
  await expect.poll(async () => {
    const workspaceLoading = await win.getByTestId('workspace-loading').isVisible().catch(() => false)
    const detail = await win.getByTestId('view-detail').isVisible().catch(() => false)
    return workspaceLoading || detail
  }).toBe(true)
  const workspaceOpened = await win.getByTestId('workspace-loading').isVisible().catch(() => false)
  if (workspaceOpened) {
    // loading 消失后的确定终态有两种:工作区打开(启动成功)或回落详情页(启动被拒/失败)。
    await expect.poll(async () => {
      const back = await win.getByTestId('workspace-back-btn').isVisible().catch(() => false)
      const detail = await win.getByTestId('view-detail').isVisible().catch(() => false)
      return back || detail
    }).toBe(true)
    const opened = await win.getByTestId('workspace-back-btn').isVisible().catch(() => false)
    if (opened) {
      const toolbarLayout = await win.evaluate(() => {
        const topbar = document.querySelector('.topbar')?.getBoundingClientRect()
        const back = document.querySelector('[data-testid="workspace-back-btn"]')?.getBoundingClientRect()
        return topbar && back ? { topbarRight: topbar.right, backRight: back.right } : null
      })
      expect(toolbarLayout).not.toBeNull()
      if (toolbarLayout) expect(toolbarLayout.topbarRight - toolbarLayout.backRight).toBeLessThanOrEqual(16)
      await win.getByTestId('workspace-back-btn').click()
    }
  }
  await expect(win.getByTestId('view-detail')).toBeVisible()
  // 底部信息栏常驻详情页（空态或已有活动日志）。
  await expect(win.getByTestId('detail-logbar')).toBeVisible()
  const deleteButton = win.getByTestId('delete-btn')
  await expect(deleteButton).toBeVisible()
  const deleteMetrics = await deleteButton.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })
  expect(deleteMetrics.height).toBeGreaterThanOrEqual(46)
  const deletePosition = await win.evaluate(() => {
    const button = document.querySelector('[data-testid="delete-btn"]')
    if (!button) return null
    const box = button.getBoundingClientRect()
    const style = getComputedStyle(button)
    return { right: window.innerWidth - box.right, bottom: window.innerHeight - box.bottom, position: style.position }
  })
  // 删除按钮悬在底部信息栏之上（信息栏 44px + 16px 间隙），右缘 20px。
  expect(deletePosition).toEqual({ right: 20, bottom: 60, position: 'fixed' })
  const overviewMetrics = await win.getByTestId('detail-overview-btn').evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })
  expect(overviewMetrics.width).toBeGreaterThan(overviewMetrics.height)
  await expect(win.getByTestId('detail-overview-btn')).toHaveCSS('white-space', 'nowrap')
  await expect(win.getByTestId('detail-delete-area')).toBeVisible()

  // 删除(二次确认)→ 回空态
  await deleteButton.click()
  await expect(win.getByTestId('confirm-delete')).toBeVisible()
  await win.getByTestId('confirm-delete').getByRole('button', { name: '删除', exact: true }).click({ force: true })
  await expect(win.getByTestId('view-empty')).toBeVisible()
})