import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 「dsh 升级后首次启动自动禁用不兼容插件」的界面提示：主进程核对结果写在
 * `<DATA_DIR>/plugin-state/<id>.json` 的 autoDisabled 里，插件卡挂载时读取并提示。
 * 这里直接播种该状态文件，验证「主进程状态 → 界面提示条 → 可关闭」这条链路。
 */
const VERSION = '0.1.7-rc.2'
const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-plugins-auto-disabled')
const ENTRY_DIR = join(DATA_DIR, 'runtimes', `dsh-${VERSION}`, 'node_modules', '@deepseek-ai', 'dsh', 'lib')

let app: ElectronApplication
let win: Page

/** 只认 list 的假 dsh 入口。 */
const FAKE_BIN = `
const args = process.argv.slice(2)
const i = args.indexOf('plugin')
if (i === -1) process.exit(0)
const rest = args.slice(i + 1)
let sub = rest
const p = rest.indexOf('--profile')
if (p !== -1) sub = rest.slice(0, p).concat(rest.slice(p + 2))
if (sub[0] === 'list') {
  process.stdout.write(JSON.stringify([{
    name: 'dsh-profile-web',
    dependencies: {
      'demo-plugin': {
        from: 'demo-plugin',
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.0.0.tgz',
        path: ${JSON.stringify(join(DATA_DIR, 'fake-plugin'))}
      }
    }
  }]))
  process.exit(0)
}
process.exit(0)
`

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(ENTRY_DIR, { recursive: true })
  await writeFile(join(ENTRY_DIR, 'bin.js'), FAKE_BIN, 'utf8')
  const pluginDir = join(DATA_DIR, 'fake-plugin')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'demo-plugin',
      version: '1.0.0',
      description: '示例插件',
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }
    }),
    'utf8'
  )

  app = await electron.launch({
    args: buildLaunchArgs(),
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()

  const created = await win.evaluate(
    async (version) =>
      window.dshHub.instances.create({
        transport: 'local',
        name: '自动禁用实例',
        authMode: 'none',
        dshVersion: version
      }),
    VERSION
  )
  if (!created.ok) throw new Error('创建实例失败')

  // profile 清单：插件被自动禁用后已不在 bundles 里（保留 dependencies）。
  const profileDir = join(DATA_DIR, 'homes', created.value.id, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
        dependencies: { 'demo-plugin': '1.0.0' }
      },
      undefined,
      2
    )}\n`,
    'utf8'
  )

  // 主进程核对结果：demo-plugin 与新版 dsh 不兼容，已被自动禁用。
  const stateDir = join(DATA_DIR, 'plugin-state')
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    join(stateDir, `${created.value.id}.json`),
    `${JSON.stringify(
      {
        lastCheckedAt: null,
        updates: {},
        bundleIndex: { 'demo-plugin': 1 },
        runtimeVersion: VERSION,
        autoDisabled: [{ name: 'demo-plugin', version: '1.0.0', dshVersion: VERSION }]
      },
      undefined,
      2
    )}\n`,
    'utf8'
  )

  await win.reload()
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })
})

test.afterAll(async () => {
  await app.close()
  await rm(DATA_DIR, { recursive: true, force: true })
})

test('自动禁用提示：卡片顶部提示不兼容插件，且该行标注已禁用，可关闭提示', async () => {
  test.setTimeout(90_000)
  await win.locator('[data-testid^="detail-"]').first().click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByTestId('plugins-card')).toBeVisible()

  const banner = win.getByTestId('plugins-auto-disabled')
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await expect(banner).toContainText('demo-plugin')
  // 该插件同时以「已禁用」标注出现在列表里（仍可见）
  await expect(win.getByTestId('plugin-disabled-demo-plugin')).toBeVisible()

  await win.getByTestId('plugins-auto-disabled-dismiss').click()
  await expect(banner).toBeHidden()
})
