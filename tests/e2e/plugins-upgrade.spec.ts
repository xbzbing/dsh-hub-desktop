import { rm } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eDataDir } from './data-dir'
import {
  INSTALLED_VERSION,
  LATEST_VERSION,
  launchPluginApp,
  openDetail,
  readMutations,
  seedInstance,
  seedPluginFixture,
  type PluginFixture
} from './plugins-fixture'
import { pickOption } from './select'

/**
 * 升级二次确认：弹窗给出目标版本与来源，取消不执行，确认按选定来源下发 remove → add。
 *
 * 「升级中不可取消 / 放到后台」需要人为拖慢变更，放在 `plugins-upgrade-background.spec.ts`。
 */
const DATA_DIR = e2eDataDir('e2e-plugins-upgrade')

let app: ElectronApplication
let win: Page
let fixture: PluginFixture

test.beforeAll(async () => {
  fixture = await seedPluginFixture(DATA_DIR)
  const launched = await launchPluginApp(DATA_DIR)
  app = launched.app
  win = launched.win
  await seedInstance(win, DATA_DIR)
})

test.afterAll(async () => {
  await app.close()
  await rm(DATA_DIR, { recursive: true, force: true })
})

test('升级二次确认：弹窗给出目标版本，取消不执行、确认才升级', async () => {
  test.setTimeout(120_000)
  await openDetail(win)
  const upgrade = win.getByTestId('plugin-upgrade-demo-plugin')
  if (!(await upgrade.isVisible())) {
    await win.getByTestId('plugin-check-demo-plugin').click()
  }
  await expect(upgrade).toBeVisible({ timeout: 20_000 })
  const before = (await readMutations(fixture.mutationLog)).length

  await upgrade.click()
  const dialog = win.getByTestId('upgrade-confirm-dialog')
  await expect(dialog).toBeVisible()
  await expect(win.getByTestId('upgrade-confirm-submit')).toContainText(LATEST_VERSION, {
    timeout: 20_000
  })
  // 升级不改启用态：不出现「安装后启用」勾选，也没有它的说明气泡。
  await expect(win.getByTestId('install-confirm-enable-after')).toHaveCount(0)
  await expect(dialog.locator('.info-tip')).toHaveCount(0)
  // 与安装第二步同宽：同一套确认区不因入口不同而变窄。
  expect((await dialog.boundingBox())?.width ?? 0).toBeGreaterThan(500)

  // 解析完成后安装源自动收起：标题行补上当前档位，正文让给版本与安全检查。
  const source = win.getByTestId('upgrade-confirm-source')
  const sourceToggle = win.getByTestId('upgrade-confirm-source-toggle')
  await expect(sourceToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(source).toHaveCount(0)
  await expect(dialog.locator('.section-summary')).toContainText('npmmirror')
  await expect(dialog.locator('.card-head .badge').first()).toContainText('npmmirror')
  // 需要改选时再展开，选择器与徽标同档。
  await sourceToggle.click()
  await expect(source).toHaveAttribute('data-value', 'npmmirror')
  await sourceToggle.click()
  await expect(source).toHaveCount(0)
  // 版本演进：左旧右新（已装 1.0.0 → 目标 1.1.0）。
  const versionRow = win.getByTestId('install-confirm-version')
  await expect(versionRow).toContainText(INSTALLED_VERSION)
  await expect(versionRow).toContainText('→')
  await expect(versionRow).toContainText(LATEST_VERSION)
  // 插件名显示在版本行之上，且就是本次点开的对象：先看清升级谁，避免点错。
  const nameRow = win.getByTestId('install-confirm-name')
  await expect(nameRow).toHaveText('demo-plugin')
  const nameBox = await nameRow.boundingBox()
  const versionBox = await versionRow.boundingBox()
  expect(nameBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(versionBox?.y ?? -1)

  // 信息栏可折叠：收起「将升级到」只藏事实行，标题与来源徽标仍在。
  const factsToggle = win.getByTestId('install-confirm-facts-toggle')
  await factsToggle.click()
  await expect(versionRow).toBeHidden()
  await expect(dialog.locator('.card-head .badge').first()).toBeVisible()
  await factsToggle.click()
  await expect(versionRow).toBeVisible()

  // 无风险时安全检查默认收起；展开它会让安装源自动收起，把纵向空间让给检查结果。
  await expect(win.getByTestId('plugin-security-panel')).toHaveAttribute('data-verdict', 'pass', {
    timeout: 20_000
  })
  const securityToggle = win.getByTestId('plugin-security-toggle')
  await expect(securityToggle).toHaveAttribute('aria-expanded', 'false')
  await securityToggle.click()
  await expect(source).toHaveCount(0)
  await expect(sourceToggle, '安装源在安全检查展开时保持收起').toHaveAttribute(
    'aria-expanded',
    'false'
  )
  await sourceToggle.click()
  await expect(source).toBeVisible()

  // 取消：不产生任何改动。
  await win.getByTestId('upgrade-confirm-cancel').click()
  await expect(dialog).toBeHidden()
  expect((await readMutations(fixture.mutationLog)).length).toBe(before)

  // 确认后才执行升级：改选安装源后按新源解析，add 必须带新源的 --registry。
  await upgrade.click()
  await expect(dialog).toBeVisible()
  // 解析完成后安装源已收起，改选前先展开。
  await expect(versionRow).toBeVisible({ timeout: 20_000 })
  await sourceToggle.click()
  await pickOption(win, 'upgrade-confirm-source', 'npmjs')
  // 改选即作废当前计划（确认区收回）→ 按 npmjs 重新解析出同一目标版本后确认区才回来。
  await expect(versionRow).toBeHidden()
  await expect(versionRow).toBeVisible({ timeout: 20_000 })
  await expect(versionRow).toContainText(LATEST_VERSION)
  await expect(dialog.locator('.card-head .badge').first()).toContainText('npmjs')
  await win.getByTestId('upgrade-confirm-submit').click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
  const mutations = await readMutations(fixture.mutationLog)
  // 与 dsh 官方 updateBundle 同口径（web profile 有 HMR）：先停止并移除旧版本，再安装新版本。
  expect(mutations.length).toBe(before + 2)
  expect(mutations.at(-2)?.cmd).toBe('remove')
  expect(mutations.at(-2)?.args).toEqual(['demo-plugin'])
  expect(mutations.at(-1)?.cmd).toBe('add')
  expect(mutations.at(-1)?.args[0]).toBe(`demo-plugin@${LATEST_VERSION}`)
  expect(mutations.at(-1)?.args).toContain('--registry')
  expect(mutations.at(-1)?.args).toContain('https://registry.npmjs.org')
})
