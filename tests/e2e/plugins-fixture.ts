/**
 * 插件相关 E2E 的共享装置。
 *
 * 假 dsh 入口、假包清单、实例与 profile 播种原本写在单个 spec 里；按场景拆成多个
 * spec 后，这些装置必须只有一份 —— 否则各文件里的假 registry 行为会逐份漂移。
 *
 * 每个 spec 仍各自持有 `hub-data/e2e-*` 数据目录与一次应用启动，因此可以跨文件并行。
 */
import { expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { e2eEnv } from './data-dir'
import { buildLaunchArgs } from './launch-args'
import { securityReportEnv } from './security-report'

/** 播种实例固定使用的 dsh 版本：`resolveDshEntry` 因此命中隔离目录里的假 bin.js。 */
export const VERSION = '0.1.7-rc.2'

/** 假插件已装版本与它在假 registry 里的发布时间（view 的 time 映射中已装版本那一项）。 */
export const INSTALLED_VERSION = '1.0.0'
export const INSTALLED_PUBLISHED_AT = '2026-09-20T02:30:00.000Z'

/**
 * 假 registry 的候选版本：故意不按版本序排列（`1.0.10` 在 `1.0.9` 前），
 * 且 dist-tag `latest` 停在已装版本（滞后）——解析必须取「最大稳定版」而不是末位或 dist-tag。
 */
export const LATEST_VERSION = '1.1.0'
export const FAKE_VERSIONS = ['1.0.0', '1.0.10', '1.0.9', LATEST_VERSION]

/** 假 dsh 记录的 add/remove 调用。 */
export interface FakeMutation {
  cmd: string
  args: string[]
}

/** 数据目录内的假包、插桩与环境文件路径。 */
export interface PluginFixture {
  dataDir: string
  /** 假 dsh 的 add/remove 插桩：每次变更追加一行 JSON。 */
  mutationLog: string
  /** 假 dsh 入口目录（<dataDir>/runtimes/dsh-<version>/node_modules/@deepseek-ai/dsh/lib）。 */
  entryDir: string
}

/**
 * 假 dsh 入口：只认 `plugin --profile <p> <sub> ...`。
 * - list --json：一个含 host+client 半的 npm 插件（DSH_E2E_PLUGIN_SECOND=1 时再加一个，
 *   用于验证「放到后台」只对当前插件生效）；
 * - view ... --json：版本信息（versions 故意乱序且 dist-tag 滞后，用于验证解析不取末位、
 *   也不盲信 dist-tag）；`DSH_E2E_PLUGIN_INCOMPAT=1` 时返回不兼容 peer；
 * - add / remove：追加到 DSH_E2E_PLUGIN_ADD_LOG（若有），供断言实际下发的 spec 与 --registry。
 */
function fakeBin(dataDir: string): string {
  return `
const fs = require('fs')
const args = process.argv.slice(2)
const i = args.indexOf('plugin')
if (i === -1) { process.exit(0) }
const rest = args.slice(i + 1)
// 跳过 --profile <name>
let sub = rest
const p = rest.indexOf('--profile')
if (p !== -1) sub = rest.slice(0, p).concat(rest.slice(p + 2))
const cmd = sub[0]
if (cmd === 'list') {
  const deps = {
    'demo-plugin': {
      from: 'demo-plugin',
      version: ${JSON.stringify(INSTALLED_VERSION)},
      resolved: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.0.0.tgz',
      path: ${JSON.stringify(join(dataDir, 'fake-plugin'))}
    }
  }
  if (process.env.DSH_E2E_PLUGIN_SECOND === '1') {
    deps['other-plugin'] = {
      from: 'other-plugin',
      version: ${JSON.stringify(INSTALLED_VERSION)},
      resolved: 'https://registry.npmjs.org/other-plugin/-/other-plugin-1.0.0.tgz',
      path: ${JSON.stringify(join(dataDir, 'fake-plugin-2'))}
    }
  }
  process.stdout.write(JSON.stringify([{ name: 'dsh-profile-web', dependencies: deps }]))
  process.exit(0)
}
if (cmd === 'view') {
  // 可选延迟：用于验证「批量检查期间单行检查按钮锁定」。
  const delay = Number(process.env.DSH_E2E_PLUGIN_VIEW_DELAY_MS || '0')
  if (delay > 0) { const until = Date.now() + delay; while (Date.now() < until) {} }
  const incompat = process.env.DSH_E2E_PLUGIN_INCOMPAT === '1'
  process.stdout.write(JSON.stringify({
    version: ${JSON.stringify(LATEST_VERSION)},
    versions: ${JSON.stringify(FAKE_VERSIONS)},
    'dist-tags': { latest: ${JSON.stringify(INSTALLED_VERSION)} },
    peerDependencies: { '@deepseek-ai/dsh': incompat ? '>=0.2.0' : '>=0.1.7-rc.2' },
    repository: { type: 'git', url: 'git+https://github.com/demo/demo-plugin.git' },
    time: { ${JSON.stringify(INSTALLED_VERSION)}: ${JSON.stringify(INSTALLED_PUBLISHED_AT)}, ${JSON.stringify(LATEST_VERSION)}: '2026-09-28T11:16:59.586Z' }
  }))
  process.exit(0)
}
if (cmd === 'add' || cmd === 'remove') {
  // 可选延迟：用于验证「升级开始后不可取消、可放到后台」的可观察窗口；日志在延迟后写，
  // 读到记录即代表这次改动已完成。
  const delay = Number(process.env.DSH_E2E_PLUGIN_MUTATION_DELAY_MS || '0')
  if (delay > 0) { const until = Date.now() + delay; while (Date.now() < until) {} }
  const log = process.env.DSH_E2E_PLUGIN_ADD_LOG
  if (log) {
    try { fs.appendFileSync(log, JSON.stringify({ cmd: cmd, args: sub.slice(1) }) + '\\n') } catch (error) {}
  }
  process.stdout.write('ok')
  process.exit(0)
}
process.exit(0)
`
}

export const FAKE_PLUGIN_MANIFEST = {
  name: 'demo-plugin',
  version: '1.0.0',
  description: '示例插件',
  author: 'demo-author',
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/demo/demo-plugin.git' },
  dependencies: { 'left-pad': '^1.0.0' },
  peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
  engines: { node: '>=20' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }
}

/** 读取假 dsh 的 add/remove 记录。文件不存在时视为空。 */
export async function readMutations(mutationLog: string): Promise<FakeMutation[]> {
  try {
    const text = await readFile(mutationLog, 'utf8')
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as FakeMutation)
  } catch {
    return []
  }
}

/** 与渲染层 fmtLogTime 同口径（本地时区，YYYY-MM-DD HH:mm:ss）。 */
export function fmtLogTime(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * 重建数据目录并播种假 dsh 与假包清单。
 *
 * 同时设置 `DSH_E2E_PLUGIN_ADD_LOG`：假 bin.js 由应用进程 spawn，继承启动环境，
 * 因此必须在 `launchPluginApp` 之前写进 `process.env`。
 */
export async function seedPluginFixture(dataDir: string): Promise<PluginFixture> {
  await rm(dataDir, { recursive: true, force: true })
  const entryDir = join(
    dataDir,
    'runtimes',
    `dsh-${VERSION}`,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib'
  )
  await mkdir(entryDir, { recursive: true })
  await writeFile(join(entryDir, 'bin.js'), fakeBin(dataDir), 'utf8')

  const pluginDir = join(dataDir, 'fake-plugin')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify(FAKE_PLUGIN_MANIFEST), 'utf8')
  // 第二个插件的假包清单：与 demo-plugin 同构，仅名称/作者不同（配合 DSH_E2E_PLUGIN_SECOND）。
  const otherManifest = { ...FAKE_PLUGIN_MANIFEST, name: 'other-plugin', author: 'other-author' }
  const otherDir = join(dataDir, 'fake-plugin-2')
  await mkdir(otherDir, { recursive: true })
  await writeFile(join(otherDir, 'package.json'), JSON.stringify(otherManifest), 'utf8')

  const mutationLog = join(dataDir, 'plugin-mutations.jsonl')
  process.env.DSH_E2E_PLUGIN_ADD_LOG = mutationLog
  return { dataDir, mutationLog, entryDir }
}

/**
 * 启动应用并等到渲染层加载完成；插件用例的每次（重）启动都走这里。
 *
 * 首个实例创建前注册表是空的，主区渲染 `view-empty`（`App.tsx` 的 `instances.length === 0`
 * 分支），此后才是 `view-home`；重启时若恢复了上次的详情页则是 `view-detail`。三者任一出现
 * 都说明 `loaded` 已置位、IPC 可用。
 */
export async function launchPluginApp(
  dataDir: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: buildLaunchArgs(),
    env: e2eEnv(dataDir, { ...securityReportEnv(dataDir), ...extraEnv })
  })
  const win = await app.firstWindow()
  await expect(
    win
      .getByTestId('view-home')
      .or(win.getByTestId('view-empty'))
      .or(win.getByTestId('view-detail'))
      .first()
  ).toBeVisible({ timeout: 15_000 })
  return { app, win }
}

/**
 * 播种一个固定 `VERSION` 的本机实例，并写好 profile 的加载清单：
 * 清单决定「启用/禁用」，Hub 改的就是它；假 dsh 的 list 则始终报告两个插件已装。
 */
export async function seedInstance(win: Page, dataDir: string): Promise<string> {
  const created = await win.evaluate(
    async (version) =>
      window.dshHub.instances.create({
        transport: 'local',
        name: '插件测试实例',
        authMode: 'none',
        dshVersion: version
      }),
    VERSION
  )
  expect(created.ok).toBe(true)
  if (!created.ok) throw new Error('创建实例失败')

  const profileDir = join(dataDir, 'homes', created.value.id, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-plugin', 'other-plugin'] } },
        dependencies: { 'demo-plugin': '1.0.0', 'other-plugin': '1.0.0' }
      },
      undefined,
      2
    )}\n`,
    'utf8'
  )
  await win.reload()
  await expect(win.getByTestId('view-home')).toBeVisible({ timeout: 15_000 })
  return created.value.id
}

/**
 * 打开该实例详情（本机未运行 → openFromSidebar 不直接进工作区，用 detail 按钮直达）。
 * 侧栏详情按钮是开关：已在详情页时再点会收起，故先判断。
 */
export async function openDetail(win: Page): Promise<void> {
  if (await win.getByTestId('view-detail').isVisible()) {
    await expect(win.getByTestId('plugins-card')).toBeVisible()
    return
  }
  const detailBtn = win.locator('[data-testid^="detail-"]').first()
  await detailBtn.click()
  await expect(win.getByTestId('view-detail')).toBeVisible()
  await expect(win.getByTestId('plugins-card')).toBeVisible()
}

/** 展开插件详情（已展开时不再点，避免收起）。 */
export async function expandDetail(win: Page): Promise<void> {
  const detail = win.getByTestId('plugin-detail-demo-plugin')
  if (!(await detail.isVisible())) await win.getByTestId('plugin-expand-demo-plugin').click()
  await expect(detail).toBeVisible()
}
