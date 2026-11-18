import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eDataDir } from './data-dir'
import { launchPluginApp, openDetail, seedInstance, seedPluginFixture } from './plugins-fixture'

/**
 * profile 写锁预检：残留锁在插件命令前被挪走，活锁原样保留。
 *
 * dsh 的 atomic-write 分两步建锁（先建文件、再写 PID），进程在两步之间被杀会留下 0 字节锁；
 * 其回收逻辑只认 `<pid>\n`，空记录永远不匹配，此后每条 `dsh plugin` 命令都要空等 120 秒。
 * 这里的用例守着 Hub 的预检两侧：残留锁进 `<dataDir>/stale-locks/`，被存活进程持有的锁不动。
 */
const DATA_DIR = e2eDataDir('e2e-plugins-stale-lock')
const STALE_DIR = join(DATA_DIR, 'stale-locks')

let app: ElectronApplication
let win: Page
let instanceId = ''

/** 实例的 profile 目录（写锁放在这里）。 */
function profileDir(): string {
  return join(DATA_DIR, 'homes', instanceId, 'profiles', 'web')
}

/** 路径是否存在（不关心是文件还是目录）。 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 备份目录里的文件名（目录尚未创建时视为空）。 */
async function staleBackups(): Promise<string[]> {
  try {
    return (await readdir(STALE_DIR)).sort()
  } catch {
    return []
  }
}

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

/** 关掉应用、在 profile 目录写好锁（可把 mtime 回拨），再启动并回到详情页。 */
async function relaunchWithLock(lockPath: string, content: string, ageMs = 0): Promise<void> {
  await app.close()
  await mkdir(dirname(lockPath), { recursive: true })
  await writeFile(lockPath, content, 'utf8')
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs)
    await utimes(lockPath, past, past)
  }
  const launched = await launchPluginApp(DATA_DIR)
  app = launched.app
  win = launched.win
  await openDetail(win)
}

test('残留 0 字节锁：打开详情后自动挪走，插件列表正常渲染', async () => {
  test.setTimeout(90_000)
  const lockPath = join(profileDir(), 'package.json.lock')
  const before = await staleBackups()
  // 空锁要跨过 2 秒回收宽限才会被搬走（宽限用于避开「建文件 → 写 PID」的微秒级窗口），
  // 刚写入的锁 mtime 是「现在」，这里回拨 10 秒模拟真实残留锁。
  await relaunchWithLock(lockPath, '', 10_000)

  // 列表命令没有被锁挡住：插件行正常渲染。
  await expect(win.getByTestId('plugin-list')).toBeVisible({ timeout: 20_000 })
  await expect(win.getByTestId('plugin-row-demo-plugin')).toBeVisible({ timeout: 20_000 })

  // 预检在命令之前完成：锁已消失，0 字节内容原样备份到 stale-locks。
  await expect.poll(() => exists(lockPath)).toBe(false)
  await expect.poll(async () => (await staleBackups()).length).toBe(before.length + 1)
  const added = (await staleBackups()).filter((name) => !before.includes(name))
  expect(added).toHaveLength(1)
  expect(added[0] ?? '').toContain('package.json.lock')
  expect(await readFile(join(STALE_DIR, added[0] ?? ''), 'utf8')).toBe('')
})

test('活锁不动：PID 仍存活时锁留在 profile 目录，不产生备份', async () => {
  test.setTimeout(90_000)
  const lockPath = join(profileDir(), 'package.json.lock')
  // 用测试进程自己的 PID：主进程 process.kill(pid, 0) 必定判定存活。
  const content = `${process.pid}\n`
  await mkdir(profileDir(), { recursive: true })
  await writeFile(lockPath, content, 'utf8')
  const before = await staleBackups()

  // 重新加载页面会重新拉取插件列表，从而再次经过写锁预检。
  await win.reload()
  await expect(win.getByTestId('view-home').or(win.getByTestId('view-detail'))).toBeVisible({
    timeout: 15_000
  })
  await openDetail(win)
  await expect(win.getByTestId('plugin-list')).toBeVisible({ timeout: 20_000 })

  // 持有者存活：锁保持原样，没有新增备份。
  expect(await readFile(lockPath, 'utf8')).toBe(content)
  expect(await staleBackups()).toEqual(before)
  await rm(lockPath, { force: true })
})
