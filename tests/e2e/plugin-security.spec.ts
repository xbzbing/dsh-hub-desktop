import { _electron as electron, expect, test } from '@playwright/test'
import { e2eDataDir, e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import { securityReportEnv } from './security-report'
import type { ElectronApplication, Page } from '@playwright/test'
import type { PluginSecurityCheck, PluginSecurityReport } from '@shared/contracts'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 插件安装安全检查的端到端验证。
 *
 * 检查本身会下载 npm tarball；E2E 用 `DSH_HUB_E2E_SECURITY_REPORT` 注入固定报告，
 * 只验证面板状态、主按钮文案与放行/阻止的行为。五类结论各启动一次应用，避免
 * 同一实例里缓存或设置互相影响。
 */

const VERSION = '0.1.7-rc.2'
const DATA_DIR = e2eDataDir('e2e-plugin-security')
const ENTRY_DIR = join(
  DATA_DIR,
  'runtimes',
  `dsh-${VERSION}`,
  'node_modules',
  '@deepseek-ai',
  'dsh',
  'lib'
)
const MUTATION_LOG = join(DATA_DIR, 'security-mutations.jsonl')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

const FAKE_BIN = `
const fs = require('fs')
const args = process.argv.slice(2)
const i = args.indexOf('plugin')
if (i === -1) { process.exit(0) }
const rest = args.slice(i + 1)
let sub = rest
const p = rest.indexOf('--profile')
if (p !== -1) sub = rest.slice(0, p).concat(rest.slice(p + 2))
const cmd = sub[0]
if (cmd === 'list') {
  const deps = process.env.DSH_E2E_SECURITY_INSTALLED === '1'
    ? {
        'demo-plugin': {
          from: 'demo-plugin',
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.0.0.tgz',
          path: ${JSON.stringify(join(DATA_DIR, 'fake-plugin'))}
        }
      }
    : {}
  process.stdout.write(JSON.stringify([{ name: 'dsh-profile-web', dependencies: deps }]))
  process.exit(0)
}
if (cmd === 'view') {
  process.stdout.write(JSON.stringify({
    version: '1.1.0',
    versions: ['1.0.0', '1.1.0'],
    'dist-tags': { latest: '1.1.0' },
    peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
    repository: { type: 'git', url: 'git+https://github.com/demo/demo-plugin.git' },
    time: { '1.1.0': '2026-09-28T11:16:59.586Z' }
  }))
  process.exit(0)
}
if (cmd === 'add' || cmd === 'remove') {
  const log = process.env.DSH_E2E_SECURITY_ADD_LOG
  if (log) {
    try { fs.appendFileSync(log, JSON.stringify({ cmd: cmd, args: sub.slice(1) }) + '\\n') } catch (error) {}
  }
  process.stdout.write('ok')
  process.exit(0)
}
process.exit(0)
`

let app: ElectronApplication
let win: Page

async function readMutations(): Promise<Array<{ cmd: string; args: string[] }>> {
  try {
    const text = await readFile(MUTATION_LOG, 'utf8')
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { cmd: string; args: string[] })
  } catch {
    return []
  }
}

function check(
  id: PluginSecurityCheck['id'],
  level: PluginSecurityCheck['level'],
  code: string,
  params: PluginSecurityCheck['params'] = {}
): PluginSecurityCheck {
  return { id, level, code, params, findingCodes: [] }
}

function reportPatch(verdict: PluginSecurityReport['verdict']): Partial<PluginSecurityReport> {
  if (verdict === 'warn') {
    return {
      verdict,
      checks: [
        check('source', 'pass', 'source.npm'),
        check('integrity', 'pass', 'integrity.ok'),
        check('reputation', 'pass', 'reputation.established'),
        check('name', 'pass', 'name.ok'),
        check('scripts', 'warn', 'scripts.present', { count: 1 }),
        check('content', 'pass', 'content.capabilities', {
          spawn: 2,
          network: 5,
          fs: 3,
          env: 1,
          eval: 0,
          sensitive: 1,
          files: 12,
          minified: 0
        }),
        check('dependencies', 'pass', 'deps.registry-only'),
        check('vulnerabilities', 'pass', 'vuln.none')
      ],
      findings: [
        {
          code: 'scripts.present',
          level: 'warn',
          count: 1,
          evidence: [{ file: 'package.json', line: null, match: 'postinstall' }],
          refs: []
        }
      ]
    }
  }
  if (verdict === 'blocked') {
    return {
      verdict,
      checks: [
        check('source', 'pass', 'source.npm'),
        check('integrity', 'blocked', 'integrity.mismatch'),
        check('content', 'skip', 'content.skipped')
      ],
      findings: [
        {
          code: 'integrity.mismatch',
          level: 'danger',
          count: 1,
          evidence: [{ file: null, line: null, match: 'sha512 mismatch' }],
          refs: []
        }
      ],
      essentialComplete: true
    }
  }
  if (verdict === 'unavailable') {
    return {
      verdict,
      essentialComplete: false,
      partial: true,
      checks: [
        check('source', 'skip', 'source.unavailable'),
        check('integrity', 'skip', 'integrity.unavailable'),
        check('content', 'skip', 'content.skipped')
      ]
    }
  }
  return { verdict }
}

async function launch(
  patch: Partial<PluginSecurityReport> = {},
  preserveData = false,
  extraEnv: Record<string, string> = {}
): Promise<void> {
  if (!preserveData) await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(ENTRY_DIR, { recursive: true })
  await writeFile(join(ENTRY_DIR, 'bin.js'), FAKE_BIN, 'utf8')
  process.env.DSH_E2E_SECURITY_ADD_LOG = MUTATION_LOG
  app = await electron.launch({
    args: buildLaunchArgs(),
    env: e2eEnv(DATA_DIR, { ...securityReportEnv(DATA_DIR, patch), ...extraEnv })
  })
  win = await app.firstWindow()
  const created = await win.evaluate(
    async (version) =>
      window.dshHub.instances.create({
        transport: 'local',
        name: '安全检查测试实例',
        authMode: 'none',
        dshVersion: version
      }),
    VERSION
  )
  expect(created.ok).toBe(true)
  await win.reload()
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })
}

async function openDetail(): Promise<void> {
  if (!(await win.getByTestId('view-detail').isVisible())) {
    await win.locator('[data-testid^="detail-"]').first().click()
  }
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByTestId('plugins-card')).toBeVisible()
}

async function openInstallDialog(): Promise<void> {
  await openDetail()
  await win.getByTestId('plugins-install-btn').click()
  await expect(win.getByTestId('install-plugin-dialog')).toBeVisible()
  await win.getByTestId('install-plugin-input').fill('demo-plugin')
  await win.getByTestId('install-plugin-submit').click()
  await expect(win.getByTestId('install-confirm-version')).toBeVisible({ timeout: 20_000 })
}

test.afterEach(async () => {
  await app.close()
  await rm(DATA_DIR, { recursive: true, force: true })
})

test('pass：显示未发现明显风险，主按钮保持普通安装', async () => {
  test.setTimeout(90_000)
  await launch()
  await openInstallDialog()
  const panel = win.getByTestId('plugin-security-panel')
  await expect(panel).toHaveAttribute('data-verdict', 'pass', { timeout: 15_000 })
  await expect(panel).toContainText('未发现明显风险')
  await expect(win.getByTestId('install-plugin-submit')).toContainText('安装 1.1.0')
  await expect(win.getByTestId('install-plugin-back')).toHaveCount(0)
})

test('warn：显示需要留意的项目，确认「仍要安装」后真正下发安装', async () => {
  test.setTimeout(90_000)
  await launch(reportPatch('warn'))
  await openInstallDialog()
  const panel = win.getByTestId('plugin-security-panel')
  await expect(panel).toHaveAttribute('data-verdict', 'warn', { timeout: 15_000 })
  await expect(panel).toContainText('有 1 项需要留意')
  await expect(win.getByTestId('install-plugin-submit')).toContainText('仍要安装 1.1.0')
  await win.getByTestId('install-plugin-submit').click()
  await expect(win.getByTestId('install-plugin-dialog')).toBeHidden({ timeout: 30_000 })
  expect((await readMutations()).length).toBe(1)
})

test('升级：warn 确认后先移除旧版本再安装新版本', async () => {
  test.setTimeout(90_000)
  await launch(reportPatch('warn'), false, { DSH_E2E_SECURITY_INSTALLED: '1' })
  await openDetail()
  await win.getByTestId('plugin-check-demo-plugin').click()
  const upgrade = win.getByTestId('plugin-upgrade-demo-plugin')
  await expect(upgrade).toBeVisible({ timeout: 20_000 })
  await upgrade.click()
  const dialog = win.getByTestId('upgrade-confirm-dialog')
  await expect(dialog).toBeVisible()
  const panel = win.getByTestId('plugin-security-panel')
  await expect(panel).toHaveAttribute('data-verdict', 'warn', { timeout: 15_000 })
  await expect(win.getByTestId('upgrade-confirm-submit')).toContainText('仍要升级到 1.1.0')
  await win.getByTestId('upgrade-confirm-submit').click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  const mutations = await readMutations()
  expect(mutations.map((item) => item.cmd)).toEqual(['remove', 'add'])
})

test('blocked：不提供安装按钮，返回修改回到第一步', async () => {
  test.setTimeout(90_000)
  await launch(reportPatch('blocked'))
  await openInstallDialog()
  const panel = win.getByTestId('plugin-security-panel')
  await expect(panel).toHaveAttribute('data-verdict', 'blocked', { timeout: 15_000 })
  await expect(panel).toContainText('已阻止安装')
  await expect(win.getByTestId('install-plugin-submit')).toHaveCount(0)
  await win.getByTestId('install-plugin-back').click()
  await expect(win.getByTestId('install-plugin-input')).toBeVisible()
  await expect(win.getByTestId('install-confirm-version')).toHaveCount(0)
})

test('unavailable：关键检查未完成时允许确认后安装', async () => {
  test.setTimeout(90_000)
  await launch(reportPatch('unavailable'))
  await openInstallDialog()
  const panel = win.getByTestId('plugin-security-panel')
  await expect(panel).toHaveAttribute('data-verdict', 'unavailable', { timeout: 15_000 })
  await expect(panel).toContainText('关键检查未完成')
  await expect(win.getByTestId('install-plugin-submit')).toContainText('仍要安装 1.1.0')
})

test('设置关闭：不取报告，面板显示已关闭，主按钮正常', async () => {
  test.setTimeout(90_000)
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(SETTINGS_FILE, JSON.stringify({ pluginSecurityCheck: false }), 'utf8')
  await launch({}, true)
  await openInstallDialog()
  const panel = win.getByTestId('plugin-security-panel')
  await expect(panel).toHaveAttribute('data-verdict', 'disabled', { timeout: 15_000 })
  await expect(panel).toContainText('安装前安全检查已关闭')
  await expect(win.getByTestId('plugin-security-loading')).toHaveCount(0)
  await expect(win.getByTestId('install-plugin-submit')).toContainText('安装 1.1.0')
})

test('设置页开关关闭后持久化，重启仍为关闭', async () => {
  test.setTimeout(90_000)
  await launch()
  await win.getByTestId('settings-btn').click()
  const toggle = win.getByTestId('settings-plugin-security-check')
  await expect(toggle).toBeChecked()
  // 受控复选框要等设置写盘后的 store 更新才翻转；uncheck() 会立即断言状态，
  // Windows CI 上 IPC 稍慢就会误报「点击未改变状态」。显式等待状态收敛。
  await toggle.click()
  await expect(toggle).not.toBeChecked({ timeout: 15_000 })
  await expect
    .poll(async () => {
      const raw = await readFile(SETTINGS_FILE, 'utf8')
      return (JSON.parse(raw) as { pluginSecurityCheck?: boolean }).pluginSecurityCheck
    })
    .toBe(false)
  await app.close()

  app = await electron.launch({
    args: buildLaunchArgs(),
    env: e2eEnv(DATA_DIR, securityReportEnv(DATA_DIR))
  })
  win = await app.firstWindow()
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })
  await win.getByTestId('settings-btn').click()
  await expect(win.getByTestId('settings-plugin-security-check')).not.toBeChecked()
})
