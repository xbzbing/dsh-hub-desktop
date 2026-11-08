import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eDataDir } from './data-dir'
import {
  VERSION,
  launchPluginApp,
  openDetail,
  seedInstance,
  seedPluginFixture
} from './plugins-fixture'

/**
 * 检查升级的异常分支：不兼容（警告不给升级）、批量检查期间锁定、陈旧记录失效。
 *
 * 每条用例按需以不同的假 dsh 环境（不兼容 / view 慢响应）重启应用，
 * 因此本文件不能与其它插件 spec 共用进程。
 */
const DATA_DIR = e2eDataDir('e2e-plugins-check')

let app: ElectronApplication
let win: Page
let instanceId = ''

test.beforeAll(async () => {
  await seedPluginFixture(DATA_DIR)
  const launched = await launchPluginApp(DATA_DIR)
  app = launched.app
  win = launched.win
  instanceId = await seedInstance(win, DATA_DIR)
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

test('检查升级（不兼容）：给警告不给升级按钮', async () => {
  test.setTimeout(90_000)
  // 关掉再以不兼容开关重启应用，让假 bin.js 的 view 返回高版本 peer。
  await relaunch({ DSH_E2E_PLUGIN_INCOMPAT: '1' })

  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })
  await win.getByTestId('plugin-check-demo-plugin').click()
  // 不兼容：出现警告，且不出现升级按钮。
  const status = win.getByTestId('plugin-incompatible-demo-plugin')
  await expect(status).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toHaveCount(0)

  // 行内说明按宽度截断：hover 展开气泡给出完整文案（与截断前同文）。
  const tip = win.locator('.info-tip').filter({ has: status })
  const bubble = tip.locator('.info-tip-bubble')
  await expect(bubble).toHaveText((await status.textContent()) ?? '')
  await status.hover()
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')

  // 点选文本（复制长文案的常见动作）后鼠标离开：气泡必须收起 —— 焦点展开只认键盘焦点，
  // 否则被点过的行气泡常驻，再 hover 相邻行会同时展开两个气泡。
  await status.click()
  await win.mouse.move(4, 4)
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('0')
  // 键盘 Tab 往返重新聚焦仍然展开（键盘/读屏用户可读完整说明）。
  await win.keyboard.press('Tab')
  await win.keyboard.press('Shift+Tab')
  await expect.poll(() => bubble.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')

  // 异常信息写入底部信息栏（信息栏只有一行，完整历史在「更多」弹层）。
  await win.getByTestId('detail-logbar-more').click()
  await expect(win.getByTestId('log-more-body')).toContainText('demo-plugin')
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('log-more')).toBeHidden()
})

test('一键检查：批量进行中锁定单行检查按钮，结束后解锁', async () => {
  test.setTimeout(90_000)
  // 以「view 慢响应」重启，制造可观察的批量检查窗口。
  await relaunch({ DSH_E2E_PLUGIN_VIEW_DELAY_MS: '1500' })
  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })

  const rowCheck = win.getByTestId('plugin-check-demo-plugin')
  await expect(rowCheck).toBeEnabled()
  await win.getByTestId('plugins-check-all-btn').click()

  // 批量检查进行中：单行检查按钮锁定（同一时刻只让系统检查在跑）。
  await expect(rowCheck).toBeDisabled({ timeout: 10_000 })
  // 批量结束后解锁，并给出升级按钮（view 返回 1.1.0）。
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toBeVisible({ timeout: 30_000 })
  await expect(rowCheck).toBeEnabled()

  // 有更新按类别汇总写入底部信息栏。
  await win.getByTestId('detail-logbar-more').click()
  await expect(win.getByTestId('log-more-body')).toContainText('demo-plugin')
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('log-more')).toBeHidden()
})

test('陈旧的检查记录（旧版本写入 / 已装版本更高）→ 不再显示过期提示', async () => {
  test.setTimeout(90_000)
  await openDetail(win)
  const stateDir = join(DATA_DIR, 'plugin-state')
  await mkdir(stateDir, { recursive: true })
  const stateFile = join(stateDir, `${instanceId}.json`)

  /** 覆盖状态文件后重载并打开详情，等插件行出现。 */
  const seed = async (updates: Record<string, unknown>): Promise<void> => {
    await writeFile(
      stateFile,
      JSON.stringify({
        lastCheckedAt: '2026-09-29T10:00:00.000Z',
        updates,
        published: {},
        bundleIndex: {},
        runtimeVersion: null,
        autoDisabled: []
      }),
      'utf8'
    )
    await win.reload()
    await expect(win.getByTestId('view-home').or(win.getByTestId('view-detail'))).toBeVisible({
      timeout: 15_000
    })
    await openDetail(win)
    await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 15_000 })
  }

  // 记录与已装版本（1.0.0）一致 → 正常恢复为「不兼容」警告。
  await seed({
    'demo-plugin': {
      current: '1.0.0',
      latest: '1.1.0',
      compatible: false,
      dshPeer: '>=0.2.0',
      dshVersion: VERSION
    }
  })
  await expect(win.getByTestId('plugin-incompatible-demo-plugin')).toBeVisible({ timeout: 15_000 })

  // 旧版本写入的记录（无 current）：无法校验是否仍适用 → 丢弃，不再显示过期提示。
  await seed({
    'demo-plugin': {
      latest: '0.9.5',
      compatible: false,
      dshPeer: '>=0.2.0',
      dshVersion: VERSION
    }
  })
  await expect(win.getByTestId('plugin-incompatible-demo-plugin')).toHaveCount(0)
  await expect(win.getByTestId('plugin-upgrade-demo-plugin')).toHaveCount(0)

  // 记录来自更早的已装版本（手动装了更新版）：同样失效。
  await seed({
    'demo-plugin': {
      current: '0.9.0',
      latest: '0.9.5',
      compatible: false,
      dshPeer: '>=0.2.0',
      dshVersion: VERSION
    }
  })
  await expect(win.getByTestId('plugin-incompatible-demo-plugin')).toHaveCount(0)
})
