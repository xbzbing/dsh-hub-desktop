import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * 用户反馈 #8–#11 的 E2E 确认:
 * - #9:明文连接警告收敛为「图标 + 短标签」胶囊,完整详情在 title(hover 可见)
 * - #10/#11:实例创建后可编辑(编辑按钮 + 表单 + instances:update 落盘),
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

test('#9:明文警告收敛为胶囊,完整详情经 data-tip 气泡提供(不再占整段版面)', async () => {
  // 侧栏选中 http 实例(播种的第二个)
  await win.getByTestId('instances-table').isVisible()
  await win.getByText('明文远端实例').first().click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  const pill = win.getByTestId('cleartext-warning')
  await expect(pill).toBeVisible()
  // 胶囊本体是短标签,不含整段长文案
  await expect(pill).toContainText('未加密')
  // UI 打磨 #3:完整详情改放 data-tip(hover 即现的 CSS 气泡;原生 title 在
  // Electron 下延迟不可控),读屏语义经 aria-label 保留
  const tip = await pill.getAttribute('data-tip')
  expect(tip).toContain('http://')
  expect(tip).toContain('SSH')
  expect(await pill.getAttribute('aria-label')).toBe(tip)
  // 视觉取证:详情页(含胶囊 + 编辑按钮)。
  // animations:'disabled' —— CSS 动画(如 modal fade/rise)快进到终态,避免截到半透明中间帧
  await win.screenshot({ path: join(SHOT_DIR, 'detail-cleartext-pill.png'), animations: 'disabled' })
})

test('#10/#11:本地实例可编辑 —— 名称与端口修改落盘,端口留空回到自动分配', async () => {
  await win.getByText('可编辑本地实例').first().click()
  await expect(win.getByTestId('view-detail')).toBeVisible()

  // 编辑入口存在(此前完全没有编辑按钮 —— 用户反馈 #10 的本体)
  await expect(win.getByTestId('edit-btn')).toBeVisible()
  await win.getByTestId('edit-btn').click()
  await expect(win.getByTestId('edit-dialog')).toBeVisible()
  // T8 期间视觉复核发现:toBeVisible 不检测 opacity,0.2s modal 入场动画
  // (overlay fade + modal rise)会让截图落在半透明中间帧 —— 快进动画后再截
  await win.screenshot({ path: join(SHOT_DIR, 'edit-dialog-open.png'), animations: 'disabled' })

  // #11:端口字段存在且可写;名称改写;端口设为 30567
  const portInput = win.getByTestId('edit-port')
  await expect(portInput).toBeVisible()
  await portInput.fill('30567')
  await win.getByTestId('edit-name').fill('改名后的本地实例')
  await win.getByTestId('edit-save').click()

  await expect(win.getByTestId('edit-dialog')).toBeHidden()
  // 名称出现在侧栏 + 详情标题两处 —— 取详情标题断言(strict 模式单元素)
  await expect(win.getByRole('heading', { name: '改名后的本地实例' })).toBeVisible()

  // 落盘校验:注册表文件里 name + port 都更新了
  const file = JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) as {
    instances: Array<{ name: string; port: number | null }>
  }
  const edited = file.instances.find((item) => item.name === '改名后的本地实例')
  expect(edited).toBeDefined()
  expect(edited?.port).toBe(30567)

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
