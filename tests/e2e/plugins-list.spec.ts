import { rm } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eDataDir } from './data-dir'
import {
  INSTALLED_PUBLISHED_AT,
  expandDetail,
  fmtLogTime,
  launchPluginApp,
  openDetail,
  seedInstance,
  seedPluginFixture
} from './plugins-fixture'

/**
 * 插件列表与详情：渲染、手风琴字段、检查升级（兼容）、发布时间快照、卸载确认、启用/禁用。
 *
 * 假 dsh 入口与假包清单见 `plugins-fixture`；本文件只覆盖「读」与「启用态切换」，
 * 安装与升级在各自的 spec 里，便于并行。
 */
const DATA_DIR = e2eDataDir('e2e-plugins-list')

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  await seedPluginFixture(DATA_DIR)
  const launched = await launchPluginApp(DATA_DIR)
  app = launched.app
  win = launched.win
  await seedInstance(win, DATA_DIR)
})

test.afterAll(async () => {
  await app.close()
  await rm(DATA_DIR, { recursive: true, force: true })
})

test('列表渲染 + 手风琴详情 + 检查升级（兼容给升级按钮）', async () => {
  test.setTimeout(90_000)
  await openDetail(win)

  // 列表出现该插件行。
  const row = win.getByTestId('plugin-row-demo-plugin')
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText('demo-plugin')
  await expect(row).toContainText('1.0.0')

  // 手风琴展开显示详情字段。
  await win.getByTestId('plugin-expand-demo-plugin').click()
  const detail = win.getByTestId('plugin-detail-demo-plugin')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('demo-author')
  await expect(detail).toContainText('left-pad')
  await expect(detail).toContainText('>=0.1.7-rc.2')
  // 尚未检查过：发布时间为占位文案。
  await expect(detail).toContainText('点检查升级获取')

  // 名称行：包名可点击复制，剪贴板拿到包名本身（testid 在复制按钮上）。
  const nameBtn = win.getByTestId('plugin-name-demo-plugin')
  await nameBtn.click()
  await expect(nameBtn).toHaveAttribute('data-copied', 'true')
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('demo-plugin')

  // 操作行不再放 GitHub 图标按钮（GitHub 链接行保留在详情里）。
  await expect(win.getByTestId('plugin-github-demo-plugin')).toHaveCount(0)

  // 检查升级：兼容 → 出现「升级到 1.1.0」按钮，发布时间同时取到已装版本那一条。
  await win.getByTestId('plugin-check-demo-plugin').click()
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toContainText('1.1.0')
  await expect(detail).toContainText(fmtLogTime(INSTALLED_PUBLISHED_AT))
})

test('发布时间：已装版本的快照持久化，刷新后仍在', async () => {
  test.setTimeout(90_000)
  await openDetail(win)
  await expandDetail(win)
  const detail = win.getByTestId('plugin-detail-demo-plugin')
  await expect(detail).toContainText(fmtLogTime(INSTALLED_PUBLISHED_AT))

  // 刷新：列表由主进程用落盘快照回填，不再回到「点检查升级获取」。
  await win.reload()
  await expect(win.getByTestId('view-home').or(win.getByTestId('view-detail'))).toBeVisible({
    timeout: 15_000
  })
  await openDetail(win)
  await expandDetail(win)
  await expect(detail).toContainText(fmtLogTime(INSTALLED_PUBLISHED_AT))
  await expect(detail).not.toContainText('点检查升级获取')
})

test('卸载二次确认：确认框只说明后果，不再按 host 半预告重启', async () => {
  await win.getByTestId('plugin-remove-demo-plugin').click()
  await expect(win.getByTestId('plugin-remove-confirm')).toBeVisible()
  // 是否需要重启由改动后的 application 决定（只看 profile 是否可用 HMR），
  // 确认框不按 host 半预告，避免误导。
  await expect(win.getByTestId('plugin-remove-host-hint')).toHaveCount(0)
  // 收尾：关闭确认框，避免影响后续用例。
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('plugin-remove-confirm')).toBeHidden()
})

test('禁用/启用：禁用后仍在列表可见并标注已禁用，可再次启用', async () => {
  test.setTimeout(90_000)
  await openDetail(win)
  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })
  // 初始为启用态（在 bundles 里）
  await expect(win.getByTestId('plugin-disabled-demo-plugin')).toHaveCount(0)

  // 开关初始为开（已加载）
  const toggle = win.getByTestId('plugin-toggle-demo-plugin')
  await expect(toggle).toHaveAttribute('role', 'switch')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await toggle.click()
  // 禁用后：开关变为关，行仍在，出现「已禁用」标注
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 })
  await expect(win.getByTestId('plugin-disabled-demo-plugin')).toBeVisible()
  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible()

  // 重新启用：开关回到开，标注消失
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 })
  await expect(win.getByTestId('plugin-disabled-demo-plugin')).toHaveCount(0)
})
