import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 实例详情和编辑流程的 E2E 验证：
 * - 明文连接警告显示为短标签，完整详情可悬停查看
 * - 实例创建后可编辑（编辑按钮、表单和 `instances:update` 持久化），
 *   本地实例端口可改(留空 = 自动分配)
 * 顺带产出详情页/编辑框截图(用户要求的目验材料)。
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-edit')
const REGISTRY_FILE = join(DATA_DIR, 'registry', 'instances.json')
const SHOT_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-edit-shots')

let app: ElectronApplication
let win: Page

const launchArgs = ['.']
if (process.env.CI) launchArgs.push('--no-sandbox')
for (const arg of (process.env.DSH_HUB_E2E_ARGS ?? '').split(' ').filter(Boolean)) {
  launchArgs.push(arg)
}

test.beforeAll(async () => {
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })
  app = await electron.launch({
    args: launchArgs,
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  win = await app.firstWindow()

  // 播种:1 个本地实例(验证端口编辑)+ 1 个明文 http 实例(验证警告胶囊)
  const local = await win.evaluate(async () =>
    window.dshHub.instances.create({ transport: 'local', name: '可编辑本地实例', authMode: 'auto' })
  )
  expect(local.ok).toBe(true)
  const http = await win.evaluate(async () =>
    window.dshHub.instances.create({
      transport: 'http',
      name: '明文远端实例',
      authMode: 'auto',
      endpointUrl: 'http://remote.example.com/dsh/'
    })
  )
  expect(http.ok).toBe(true)
})

test.afterAll(async () => {
  await app.close()
})

test('明文警告显示为短标签，完整详情通过 data-tip 提供', async () => {
  // 侧栏选中 http 实例(播种的第二个)
  await win.getByTestId('instances-table').isVisible()
  await win.getByText('明文远端实例').first().click()
  await expect(win.getByTestId('workspace-loading')).toBeVisible()
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible()
  await win.getByTestId('workspace-back-btn').click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  const pill = win.getByTestId('cleartext-warning')
  await expect(pill).toBeVisible()
  // 胶囊本体是短标签,不含整段长文案
  await expect(pill).toContainText('未加密')
  // 完整详情通过 data-tip 的 CSS 气泡显示，aria-label 保留读屏语义。
  const tip = await pill.getAttribute('data-tip')
  expect(tip).toContain('http://')
  expect(tip).toContain('SSH')
  expect(await pill.getAttribute('aria-label')).toBe(tip)
  // 视觉取证:详情页(含胶囊 + 编辑按钮)。
  // animations:'disabled' —— CSS 动画(如 modal fade/rise)快进到终态,避免截到半透明中间帧
  await win.screenshot({ path: join(SHOT_DIR, 'detail-cleartext-pill.png'), animations: 'disabled' })
})

test('本地实例可编辑，端口留空时回到自动分配', async () => {
  const workspaceBack = win.getByTestId('workspace-back-btn')
  if (await workspaceBack.isVisible()) await workspaceBack.click()
  await win.getByTestId('brand').click()
  await expect(win.getByTestId('instances-table')).toBeVisible()
  await win.getByTestId('instances-table').getByText('可编辑本地实例', { exact: true }).click()
  const workspaceBackAfterSelection = win.getByTestId('workspace-back-btn')
  if (await workspaceBackAfterSelection.isVisible()) await workspaceBackAfterSelection.click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // 编辑入口必须可用。
  await expect(win.getByTestId('edit-btn')).toBeVisible()
  await win.getByTestId('edit-btn').click()
  await expect(win.getByTestId('edit-dialog')).toBeVisible()
  // 截图时禁用动画，避免捕获到半透明的中间帧。
  await win.screenshot({ path: join(SHOT_DIR, 'edit-dialog-open.png'), animations: 'disabled' })

  // 端口字段可编辑；名称、启动命令修改，端口设为 30567。
  const portInput = win.getByTestId('edit-port')
  await expect(portInput).toBeVisible()
  await expect(win.getByTestId('edit-launcher')).toBeVisible()
  await win.getByTestId('edit-launcher').selectOption('dush')
  await portInput.fill('30567')
  await win.getByTestId('edit-name').fill('改名后的本地实例')
  await win.getByTestId('edit-save').click()

  await expect(win.getByTestId('edit-dialog')).toBeHidden()
  // 名称出现在侧栏 + 详情标题两处 —— 取详情标题断言(strict 模式单元素)
  await expect(win.getByRole('heading', { name: '改名后的本地实例' })).toBeVisible()

  // 落盘校验:注册表文件里 name + port 都更新了
  const file = JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) as {
    instances: Array<{ name: string; port: number | null; launcher: string | null }>
  }
  const edited = file.instances.find((item) => item.name === '改名后的本地实例')
  expect(edited).toBeDefined()
  expect(edited?.port).toBe(30567)
  expect(edited?.launcher).toBe('dush')

  // 再编辑:端口清空 → null(回到自动分配)
  await win.getByTestId('edit-btn').click()
  await expect(win.getByTestId('edit-dialog')).toBeVisible()
  await win.getByTestId('edit-port').fill('')
  await win.getByTestId('edit-save').click()
  await expect(win.getByTestId('edit-dialog')).toBeHidden()
  const file2 = JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) as {
    instances: Array<{ name: string; port: number | null }>
  }
  const cleared = file2.instances.find((item) => item.name === '改名后的本地实例')
  expect(cleared?.port).toBeNull()
  await win.screenshot({ path: join(SHOT_DIR, 'edit-saved.png'), animations: 'disabled' })
})
