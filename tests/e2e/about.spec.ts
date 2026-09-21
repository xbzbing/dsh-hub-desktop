import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * 「关于」面板：应用菜单项触发应用内对话框，展示项目主页入口与运行组件版本。
 * 前置：`pnpm build`。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-about')
const expectedVersion = (
  JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string
  }
).version

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  app = await electron.launch({
    args: buildLaunchArgs(),
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

/** 菜单文案跟随语言（zh / en 两种形态）；只认「关于」这一项，忽略 Hide/Quit 等标准项。 */
const ABOUT_LABEL = /^(关于 DSH Hub|About DSH Hub)$/

test('应用菜单的「关于」项打开面板,并展示版本与运行组件版本', async () => {
  await expect(win.getByTestId('about-dialog')).toBeHidden()
  // 订阅 about:open 的监听在 AboutDialog 挂载后才注册,必须先等渲染层挂载完再点菜单。
  await expect(win.getByTestId('app-shell')).toBeVisible()

  // 走真实菜单项（不是直接发通道）：菜单未接上时本用例必须失败。
  // 启动极慢时点击仍可能落在订阅注册之前(事件被丢弃),此时重发即可,打开面板是幂等的。
  await expect(async () => {
    const clicked = await app.evaluate(({ Menu }, pattern) => {
      const matches = new RegExp(pattern)
      const walk = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
        for (const item of items) {
          if (matches.test(item.label ?? '')) return item
          const found = item.submenu ? walk(item.submenu.items) : null
          if (found) return found
        }
        return null
      }
      const target = walk(Menu.getApplicationMenu()?.items ?? [])
      if (!target) return false
      target.click()
      return true
    }, ABOUT_LABEL)
    expect(clicked).toBe(true)
    await expect(win.getByTestId('about-dialog')).toBeVisible()
  }).toPass({ timeout: 15_000 })
  await expect(win.getByTestId('about-version')).toHaveText(`DSH Hub v${expectedVersion}`)
  await expect(win.getByTestId('about-homepage')).toBeVisible()

  // 组件版本必须与主进程实际运行的一致（Chromium 即前面升级到的 152 线）。
  const realChrome = await app.evaluate(() => process.versions.chrome)
  await expect(win.getByTestId('about-chromium')).toHaveText(realChrome)
  await expect(win.getByTestId('about-electron')).not.toBeEmpty()

  // 关闭按钮收起面板
  await win.getByTestId('about-dialog').getByRole('button', { name: /关闭|Close/ }).click()
  await expect(win.getByTestId('about-dialog')).toBeHidden()
})
