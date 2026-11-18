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
 * 安装进行中的交互：开始后不可取消、只能放到后台；后台安装的进度显示在插件卡头，
 * 结束后提示消失、列表刷新，信息栏留有安装记录。
 *
 * 用 `DSH_E2E_PLUGIN_VIEW_DELAY_MS` 把 view 拖 1.5 秒、`DSH_E2E_PLUGIN_MUTATION_DELAY_MS`
 * 把 add 拖 3 秒，分别制造解析与安装的可观察窗口；因此必须独立重启应用（默认环境用于其余插件用例）。
 */
const DATA_DIR = e2eDataDir('e2e-plugins-install-background')

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

test('安装开始后不可取消：只能放到后台，后台安装结束刷新列表并留痕', async () => {
  test.setTimeout(120_000)
  // 让假 dsh 的 view 慢 1.5 秒、add 慢 3 秒：分别拉开解析与安装的可观察窗口。
  await app.close()
  const launched = await launchPluginApp(DATA_DIR, {
    DSH_E2E_PLUGIN_VIEW_DELAY_MS: '1500',
    DSH_E2E_PLUGIN_MUTATION_DELAY_MS: '3000'
  })
  app = launched.app
  win = launched.win
  await openDetail(win)
  const before = (await readMutations(fixture.mutationLog)).length

  // 第一步解析出版本，第二步点安装才真正下发 add。
  await win.getByTestId('plugins-install-btn').click()
  const dialog = win.getByTestId('install-plugin-dialog')
  await expect(dialog).toBeVisible()
  await win.getByTestId('install-plugin-input').fill('demo-plugin')
  await win.getByTestId('install-plugin-submit').click()
  // 解析阶段仍可取消：不隐藏 X、不出现「放到后台」（等解析中的禁用态出现后再断言）。
  await expect(win.getByTestId('install-plugin-submit')).toBeDisabled()
  await expect(win.getByTestId('install-plugin-cancel')).toBeVisible()
  await expect(win.getByTestId('install-plugin-background')).toHaveCount(0)
  await expect(dialog.locator('.x-btn')).toHaveCount(1)
  await expect(win.getByTestId('install-confirm-version')).toBeVisible({ timeout: 20_000 })
  await win.getByTestId('install-plugin-submit').click()

  // 开始后不可取消：取消按钮收起、右上角关闭按钮隐藏，Escape 也关不掉。
  await expect(win.getByTestId('install-plugin-cancel')).toHaveCount(0)
  await expect(dialog.locator('.x-btn')).toHaveCount(0)
  const background = win.getByTestId('install-plugin-background')
  await expect(background).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  // 安装尚未结束：还没有 add 记录。
  expect((await readMutations(fixture.mutationLog)).length).toBe(before)

  // 放到后台：对话框收起，安装继续；卡头显示在装规格。
  await background.click()
  await expect(dialog).toBeHidden()
  const running = win.getByTestId('plugins-background-install')
  await expect(running).toBeVisible()
  await expect(running).toContainText('demo-plugin')

  // 安装完成（假 dsh 延迟 3 秒后写 add）：提示消失，信息栏有已安装记录。
  await expect
    .poll(async () => (await readMutations(fixture.mutationLog)).length, { timeout: 30_000 })
    .toBe(before + 1)
  const mutations = await readMutations(fixture.mutationLog)
  expect(mutations.at(-1)?.cmd).toBe('add')
  expect(mutations.at(-1)?.args[0]).toBe(`demo-plugin@${LATEST_VERSION}`)
  await expect(running).toBeHidden({ timeout: 15_000 })
  await win.getByTestId('detail-logbar-more').click()
  await expect(win.getByTestId('log-more-body')).toContainText(
    `插件已安装：demo-plugin@${LATEST_VERSION}`
  )
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('log-more')).toBeHidden()
})
