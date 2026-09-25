import { _electron as electron, expect, test } from '@playwright/test'
import { buildLaunchArgs } from './launch-args'
import type { ElectronApplication, Page } from '@playwright/test'
import { accessSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

/**
 * 运行时二次确认是 hub 风格的渲染层对话框（非系统原生对话框）：
 * 本机探不到任何 dsh（HOME 指向空目录、PATH 只留 npm/node 垫片、登录 shell 不可用）时，
 * 向导创建后的自动启动会走到「需要下载 dsh」确认；断言对话框出现、文案归属、
 * 取消后出列且实例停在停止态（不会真的发起下载）。
 */
const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-confirm')
const SHOT_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-shots')

let app: ElectronApplication
let win: Page
const cleanupDirs: string[] = []

/** 从 spec 进程的 PATH 里定位可执行文件（shim 目录只保留 npm/node，隐藏 dsh）。 */
function locateOnPath(binary: string): string {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, binary)
    try {
      accessSync(candidate)
      return candidate
    } catch {
      // 继续下一个 PATH 目录
    }
  }
  throw new Error(`PATH 上找不到 ${binary}，无法构造 E2E 的最小环境`)
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })

  // 最小环境：假 HOME（候选安装路径全部落空）+ 只含 npm/node 的 PATH（which 找不到 dsh）
  // + 不可用的登录 shell（登录 shell 兜底探测直接失败）。
  const fakeHome = await mkdtemp(join(tmpdir(), 'dsh-e2e-home-'))
  const shimDir = await mkdtemp(join(tmpdir(), 'dsh-e2e-path-'))
  cleanupDirs.push(fakeHome, shimDir)
  symlinkSync(locateOnPath('npm'), join(shimDir, 'npm'))
  symlinkSync(locateOnPath('node'), join(shimDir, 'node'))

  app = await electron.launch({
    args: buildLaunchArgs(),
    env: {
      ...process.env,
      DSH_HUB_DATA_DIR: DATA_DIR,
      HOME: fakeHome,
      PATH: `${shimDir}:/usr/bin:/bin`,
      SHELL: join(fakeHome, 'no-such-shell')
    }
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

test('创建后启动触发下载确认：hub 风格对话框，取消即收敛到停止态', async () => {
  test.setTimeout(90_000)
  await expect(win.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 })

  // 向导三步创建本地实例（默认启动器 dsh、未固定版本）
  await win.getByTestId('empty-new-btn').click()
  await expect(win.getByTestId('wizard')).toBeVisible()
  await win.getByRole('button', { name: '下一步' }).click()
  await win.getByTestId('wizard-name').fill('确认框实例')
  await win.getByRole('button', { name: '下一步' }).click()
  await expect(win.getByTestId('wizard-step-3')).toBeVisible()
  await win.getByTestId('wizard-create').click()
  await expect(win.getByTestId('wizard')).toBeHidden()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // hub 与 PATH 都无可用 dsh → 解析 registry latest → 下载确认等待用户拍板
  const dialog = win.getByTestId('runtime-confirm-dialog')
  await expect(dialog).toBeVisible({ timeout: 45_000 })
  await expect(dialog).toContainText('未找到可复用的 dsh 运行时')
  await expect(win.getByTestId('runtime-confirm-body')).toContainText('@deepseek-ai/dsh@')
  await expect(win.getByTestId('runtime-confirm-accept')).toHaveText('下载并启动')
  await win.screenshot({ path: join(SHOT_DIR, 'runtime-confirm.png') })

  // 取消：对话框出列，本次启动被取消，实例停在停止态（不发起任何下载）
  await win.getByTestId('runtime-confirm-cancel').click()
  await expect(dialog).toBeHidden()
  await expect
    .poll(
      async () =>
        win.evaluate(async () => {
          const listed = await window.dshHub.instances.list()
          return listed.ok ? (listed.value[0]?.runtimeStatus ?? null) : 'unknown'
        }),
      { timeout: 15_000 }
    )
    .toBe('stopped')
})
