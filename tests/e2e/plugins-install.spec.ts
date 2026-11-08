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
import { openSelect } from './select'

/**
 * 插件安装：两步确认（解析出最大稳定版、确认后才下发 add）、安装源默认档跟随应用镜像设置。
 *
 * 假 dsh 只记录 add 参数，不改真实依赖；因此这些用例之间没有状态耦合。
 */
const DATA_DIR = e2eDataDir('e2e-plugins-install')

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

test('安装两步：确定解析出版本、确认后才下发带 --registry 的 name@版本', async () => {
  test.setTimeout(120_000)
  await openDetail(win)
  const before = (await readMutations(fixture.mutationLog)).length

  await win.getByTestId('plugins-install-btn').click()
  const dialog = win.getByTestId('install-plugin-dialog')
  await expect(dialog).toBeVisible()
  // 第一步：安装源两档（默认国内镜像）+ 常驻安全提醒。
  await expect(win.getByTestId('install-plugin-source')).toHaveAttribute('data-value', 'npmmirror')
  const sourceMenu = await openSelect(win, 'install-plugin-source')
  await expect(sourceMenu).toContainText('npmjs')
  await win.keyboard.press('Escape')
  await expect(sourceMenu).toHaveCount(0)
  await expect(dialog).toContainText('来源不明的插件可能损坏 DSH')

  await win.getByTestId('install-plugin-input').fill('demo-plugin')
  await win.getByTestId('install-plugin-submit').click()

  // 第二步：解析出的版本是最大稳定版（假 registry 的 dist-tag 滞后、versions 乱序）。
  const versionRow = win.getByTestId('install-confirm-version')
  await expect(versionRow).toBeVisible({ timeout: 20_000 })
  await expect(versionRow).toContainText(LATEST_VERSION)
  // 版本演进：左旧右新 —— 已装 1.0.0 在左、目标徽标在右，箭头本身说明替换。
  await expect(versionRow).toContainText(INSTALLED_VERSION)
  await expect(versionRow).toContainText('→')
  await expect(win.getByTestId('install-confirm-downloads')).toBeVisible()
  // 插件名在版本行之上：先看清对象再读版本。
  await expect(win.getByTestId('install-confirm-name')).toHaveText('demo-plugin')
  await expect(win.getByTestId('install-plugin-submit')).toContainText(LATEST_VERSION)

  // 未点安装前不得有任何 add。
  expect((await readMutations(fixture.mutationLog)).length).toBe(before)

  // 对话框比默认（452px）宽一档：版本事实与更新内容一屏能读下。
  expect((await dialog.boundingBox())?.width ?? 0).toBeGreaterThan(500)

  // 「安装后启用」的后果说明默认不显示，hover 问号才展开；气泡贴在正文底部向上展开，
  // 且整体落在正文与对话框之内（正文是滚动容器、对话框 overflow:hidden，越界即被裁掉）。
  const tip = dialog.locator('.info-tip-above')
  const bubble = tip.locator('.info-tip-bubble')
  await expect(bubble).toHaveText('取消则只安装，插件落在「已禁用」状态')
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('0')
  await tip.locator('.info-tip-btn').hover()
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  const bubbleBox = await bubble.boundingBox()
  const bodyBox = await dialog.locator('.modal-body').boundingBox()
  const dialogBox = await dialog.boundingBox()
  expect(bubbleBox).not.toBeNull()
  expect(bodyBox).not.toBeNull()
  expect(dialogBox).not.toBeNull()
  const bubbleRect = bubbleBox ?? { x: 0, y: 0, width: 0, height: 0 }
  const bodyRect = bodyBox ?? { x: 0, y: 0, width: 0, height: 0 }
  const dialogRect = dialogBox ?? { x: 0, y: 0, width: 0, height: 0 }
  expect(Math.floor(bubbleRect.y)).toBeGreaterThanOrEqual(Math.ceil(bodyRect.y))
  expect(Math.ceil(bubbleRect.y + bubbleRect.height)).toBeLessThanOrEqual(
    Math.floor(bodyRect.y + bodyRect.height)
  )
  expect(Math.floor(bubbleRect.x)).toBeGreaterThanOrEqual(Math.ceil(dialogRect.x))
  expect(Math.ceil(bubbleRect.x + bubbleRect.width)).toBeLessThanOrEqual(
    Math.floor(dialogRect.x + dialogRect.width)
  )
  // 问号在勾选框之外：点它只读说明，不会把「安装后启用」点掉。
  await tip.locator('.info-tip-btn').click()
  await expect(win.getByTestId('install-confirm-enable-after')).toBeChecked()
  // 鼠标移开即收起，不在确认区残留气泡。
  await win.getByTestId('install-confirm-enable-after').hover()
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('0')

  await win.getByTestId('install-plugin-submit').click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
  const mutations = await readMutations(fixture.mutationLog)
  expect(mutations.length).toBe(before + 1)
  const add = mutations.at(-1)
  expect(add?.cmd).toBe('add')
  // 安装规格是解析出的具体版本，且与解析同源。
  expect(add?.args[0]).toBe(`demo-plugin@${LATEST_VERSION}`)
  expect(add?.args).toContain('--registry')
  expect(add?.args).toContain('https://registry.npmmirror.com')

  // 输入变更作废确认区：重新打开后改内容应回到第一步。
  await win.getByTestId('plugins-install-btn').click()
  await expect(dialog).toBeVisible()
  await win.getByTestId('install-plugin-input').fill('demo-plugin@1.0.0')
  await win.getByTestId('install-plugin-submit').click()
  await expect(versionRow).toContainText('重装', { timeout: 20_000 })
  // 同版本不走演进行：单徽标 + 重装说明，没有箭头。
  await expect(versionRow).not.toContainText('→')
  await win.getByTestId('install-plugin-input').fill('demo-plugin@1.0.10')
  await expect(win.getByTestId('install-confirm-version')).toHaveCount(0)
  await win.getByTestId('install-plugin-cancel').click()
  await expect(dialog).toBeHidden()
})

test('安装源默认档跟随应用镜像设置：设为 npmjs 后对话框默认 npmjs', async () => {
  test.setTimeout(120_000)
  // 应用级镜像设置为 npmjs（编辑实例对话框写的就是它），刷新让设置水合进渲染层。
  const saved = await win.evaluate(() =>
    window.dshHub.settings.update({ npmRegistry: 'https://registry.npmjs.org' })
  )
  expect(saved.ok).toBe(true)
  await win.reload()
  await expect(win.getByTestId('view-home').or(win.getByTestId('view-detail'))).toBeVisible({
    timeout: 15_000
  })
  await openDetail(win)

  // 安装第一步的默认档 = npmjs。
  await win.getByTestId('plugins-install-btn').click()
  await expect(win.getByTestId('install-plugin-dialog')).toBeVisible()
  await expect(win.getByTestId('install-plugin-source')).toHaveAttribute('data-value', 'npmjs')
  await win.getByTestId('install-plugin-cancel').click()
  await expect(win.getByTestId('install-plugin-dialog')).toBeHidden()

  // 升级确认的默认档 = npmjs（与 check 同口径），且解析出的徽标同档。
  const upgrade = win.getByTestId('plugin-upgrade-demo-plugin')
  if (!(await upgrade.isVisible())) {
    await win.getByTestId('plugin-check-demo-plugin').click()
  }
  await expect(upgrade).toBeVisible({ timeout: 20_000 })
  await upgrade.click()
  const dialog = win.getByTestId('upgrade-confirm-dialog')
  await expect(dialog).toBeVisible()
  await expect(win.getByTestId('upgrade-confirm-source')).toHaveAttribute('data-value', 'npmjs')
  await win.getByTestId('upgrade-confirm-cancel').click()
  await expect(dialog).toBeHidden()

  // 收尾：恢复默认镜像并刷新，避免影响其它用例。
  const restored = await win.evaluate(() => window.dshHub.settings.update({ npmRegistry: '' }))
  expect(restored.ok).toBe(true)
  await win.reload()
  await expect(win.getByTestId('view-home').or(win.getByTestId('view-detail'))).toBeVisible({
    timeout: 15_000
  })
})
