import { rm } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eDataDir } from './data-dir'
import {
  LATEST_VERSION,
  launchPluginApp,
  openDetail,
  readMutations,
  seedInstance,
  seedPluginFixture,
  type PluginFixture
} from './plugins-fixture'

/**
 * 升级进行中的交互：开始后不可取消、可放到后台；放到后台只作用当前插件。
 *
 * 两条用例都用 `DSH_E2E_PLUGIN_MUTATION_DELAY_MS` 把 remove/add 各拖 3 秒，
 * 制造可观察窗口；因此必须独立重启应用（默认环境用于其余插件用例）。
 */
const DATA_DIR = e2eDataDir('e2e-plugins-upgrade-background')

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

/** 以新的假 dsh 环境重启应用并回到详情页。 */
async function relaunch(extraEnv: NodeJS.ProcessEnv): Promise<void> {
  await app.close()
  const launched = await launchPluginApp(DATA_DIR, extraEnv)
  app = launched.app
  win = launched.win
  await openDetail(win)
}

test('升级开始后不可取消：只能放到后台，切走再回来仍显示升级中', async () => {
  test.setTimeout(120_000)
  // 让假 dsh 的 add/remove 慢下来，制造可观察的升级窗口（remove + add 各 3 秒）。
  await relaunch({ DSH_E2E_PLUGIN_MUTATION_DELAY_MS: '3000' })

  const upgrade = win.getByTestId('plugin-upgrade-demo-plugin')
  if (!(await upgrade.isVisible())) {
    await win.getByTestId('plugin-check-demo-plugin').click()
  }
  await expect(upgrade).toBeVisible({ timeout: 20_000 })
  const before = (await readMutations(fixture.mutationLog)).length

  await upgrade.click()
  const dialog = win.getByTestId('upgrade-confirm-dialog')
  await expect(dialog).toBeVisible()
  await win.getByTestId('upgrade-confirm-submit').click()

  // 开始后不可取消：取消按钮收起、右上角关闭按钮隐藏，Escape 也关不掉。
  await expect(win.getByTestId('upgrade-confirm-cancel')).toHaveCount(0)
  await expect(dialog.locator('.x-btn')).toHaveCount(0)
  const background = win.getByTestId('upgrade-confirm-background')
  await expect(background).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(dialog).toBeVisible()

  // 放到后台：确认框收起，升级继续；行内保持「升级中…」，本行改 profile 的操作被锁。
  await background.click()
  await expect(dialog).toBeHidden()
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toContainText('升级中', {
    timeout: 5_000
  })
  await expect(win.getByTestId('plugin-remove-demo-plugin')).toBeDisabled()

  // 回总览再进详情：插件卡重新挂载后仍按登记表认出这行在升级。
  await win.getByTestId('brand').click()
  await expect(win.getByTestId('view-home')).toBeVisible()
  await openDetail(win)
  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toContainText('升级中', {
    timeout: 5_000
  })

  // 后台升级按 remove → add 完成；列表刷新后升级标记消失，信息栏留有升级记录。
  await expect
    .poll(async () => (await readMutations(fixture.mutationLog)).length, { timeout: 30_000 })
    .toBe(before + 2)
  const mutations = await readMutations(fixture.mutationLog)
  expect(mutations.at(-2)?.cmd).toBe('remove')
  expect(mutations.at(-1)?.cmd).toBe('add')
  expect(mutations.at(-1)?.args[0]).toBe(`demo-plugin@${LATEST_VERSION}`)
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toHaveCount(0, { timeout: 15_000 })
  await win.getByTestId('detail-logbar-more').click()
  await expect(win.getByTestId('log-more-body')).toContainText(`已升级到 ${LATEST_VERSION}`)
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('log-more')).toBeHidden()
})

test('放到后台只对当前插件生效：上一个后台升级完成时不关掉新打开的确认框', async () => {
  test.setTimeout(120_000)
  // 两个插件 + 慢速变更：制造「后台升级尚未完成时又打开另一个插件确认框」的窗口。
  await relaunch({ DSH_E2E_PLUGIN_MUTATION_DELAY_MS: '3000', DSH_E2E_PLUGIN_SECOND: '1' })

  for (const name of ['demo-plugin', 'other-plugin']) {
    await expect(win.getByTestId(`plugin-row-${name}`)).toBeVisible({ timeout: 15_000 })
    const upgrade = win.getByTestId(`plugin-upgrade-${name}`)
    if (!(await upgrade.isVisible())) {
      await win.getByTestId(`plugin-check-${name}`).click()
    }
    await expect(upgrade).toBeVisible({ timeout: 20_000 })
  }
  const before = (await readMutations(fixture.mutationLog)).length

  // demo-plugin 开始升级后放到后台：确认框收起，升级继续（remove + add 各 3 秒）。
  await win.getByTestId('plugin-upgrade-demo-plugin').click()
  const dialog = win.getByTestId('upgrade-confirm-dialog')
  await expect(dialog).toBeVisible()
  await win.getByTestId('upgrade-confirm-submit').click()
  await win.getByTestId('upgrade-confirm-background').click()
  await expect(dialog).toBeHidden()

  // 后台升级未完成时打开另一个插件的确认框：显示的是后者。
  await win.getByTestId('plugin-upgrade-other-plugin').click()
  await expect(dialog).toBeVisible()
  await expect(win.getByTestId('install-confirm-name')).toHaveText('other-plugin')

  // 等 demo-plugin 的后台升级跑完（变更日志凑满 remove + add），再留出收尾窗口：
  // 收尾不得作用到此刻打开的确认框上（修复前会把它关掉，表现为「点谁的升级都被放到后台」）。
  await expect
    .poll(async () => (await readMutations(fixture.mutationLog)).length, { timeout: 30_000 })
    .toBe(before + 2)
  await win.waitForTimeout(1_500)
  await expect(dialog).toBeVisible()
  await expect(win.getByTestId('install-confirm-name')).toHaveText('other-plugin')

  // 收起确认框：没有为第二个插件下发任何变更。
  await win.getByTestId('upgrade-confirm-cancel').click()
  await expect(dialog).toBeHidden()
  expect((await readMutations(fixture.mutationLog)).length).toBe(before + 2)
})
