import { createServer, type Server } from 'node:http'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * UI E2E 与截图验证：向导布局、认证状态、明文提示、顶栏布局和详情页。
 *
 * 认证链路用本地假网关驱动(与 tests/contract 的真值口径一致):
 *   GET  /            → 302 <base>/login(网关特征)
 *   POST /login/auth  → 带 otp:200 + Set-Cookie;不带:400 otp-required(OTP 变体)
 *                       或 200 + Set-Cookie(无 OTP 变体,验证「可跳过」)
 */

const DATA_DIR = resolve(__dirname, '..', '..', 'hub-data', 'e2e-polish')
const SHOT_DIR = resolve(__dirname, '..', '..', 'hub-data', 'ui-polish-shots')

let app: ElectronApplication
let win: Page

const launchArgs = ['.']
if (process.env.CI) launchArgs.push('--no-sandbox')
for (const arg of (process.env.DSH_HUB_E2E_ARGS ?? '').split(' ').filter(Boolean)) {
  launchArgs.push(arg)
}

/** 假网关:requireOtp=false 时首登直接 200;true 时首登 400 otp-required、带码 200 */
function startFakeGateway(requireOtp: boolean): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      // 探测打 <base>/ = /dsh/(带尾斜杠);登录页特征 = 302 到 <base>/login
      if (url.pathname === '/' || url.pathname === '/dsh' || url.pathname === '/dsh/') {
        res.writeHead(302, { location: '/dsh/login' })
        res.end()
        return
      }
      if (url.pathname.endsWith('/login-api/settings')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthenticated' }))
        return
      }
      if (url.pathname.endsWith('/login/auth') && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += String(chunk)
        })
        req.on('end', () => {
          let otp: string | undefined
          try {
            otp = (JSON.parse(body) as { otp?: string }).otp
          } catch {
            otp = undefined
          }
          if (requireOtp && otp === undefined) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'otp-required' }))
            return
          }
          res.writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': 'dsh_auth=ticket123; Path=/; HttpOnly'
          })
          res.end(JSON.stringify({ ok: true }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolvePromise({ server, port })
    })
  })
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
  await expect(win.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app.close()
})

test('#4 顶栏横跨全宽:sidebar 边框不到窗口顶,红绿灯落在顶栏带内', async () => {
  // 结构断言:topbar 与 sidebar 是 app-shell 的并列 grid 项,且 topbar 在前
  const layout = await win.evaluate(() => {
    const shell = document.querySelector('[data-testid="app-shell"]')
    if (!shell) return null
    const topbar = shell.querySelector('.topbar')
    const sidebar = shell.querySelector('[data-testid="sidebar"]')
    if (!topbar || !sidebar) return null
    const tb = topbar.getBoundingClientRect()
    const sb = sidebar.getBoundingClientRect()
    const style = getComputedStyle(shell)
    return {
      topbarX: tb.x,
      topbarW: tb.width,
      shellW: shell.getBoundingClientRect().width,
      sidebarTop: sb.y,
      sidebarWidth: sb.width,
      titleX: (topbar.querySelector('.tb-title') as HTMLElement | null)?.getBoundingClientRect().x ?? null,
      topbarBottom: tb.y + tb.height,
      templateAreas: style.gridTemplateAreas,
      columns: style.gridTemplateColumns
    }
  })
  expect(layout).not.toBeNull()
  if (!layout) return
  // 顶栏从窗口最左缘开始、横跨全宽
  expect(layout.topbarX).toBe(0)
  expect(layout.topbarW).toBe(layout.shellW)
  // sidebar 从顶栏底缘开始(边框不再直达窗口顶部)
  expect(layout.sidebarTop).toBeGreaterThanOrEqual(layout.topbarBottom - 1)
  // macOS 展开态:标题与 sidebar 内容轴对齐，而不是紧贴红绿灯。
  if (layout.titleX !== null) expect(layout.titleX).toBeGreaterThanOrEqual(layout.sidebarWidth - 1)
  const railItemId = await win.evaluate(async () => {
    const result = await window.dshHub.instances.create({
      transport: 'http',
      name: '收起态留白检查',
      authMode: 'none',
      endpointUrl: 'https://rail-spacing.example.com/dsh'
    })
    if (!result.ok) throw new Error(result.message)
    return result.value.id
  })
  await win.reload()
  await expect(win.getByTestId('app-shell')).toBeVisible()
  await expect(win.getByTestId(`inst-${railItemId}`)).toBeVisible()

  // 截图目验:展开态
  await win.screenshot({ path: join(SHOT_DIR, 'shell-expanded.png'), animations: 'disabled' })

  // 折叠态(⌘B):64px 栏 + 全宽顶栏；展开/收起控件固定在侧栏底部，避免与 Logo 冲突。
  const collapseBefore = await win.getByTestId('sidebar-collapse-btn').boundingBox()
  const sidebarBefore = await win.getByTestId('sidebar').boundingBox()
  expect(collapseBefore).not.toBeNull()
  expect(sidebarBefore).not.toBeNull()
  if (collapseBefore && sidebarBefore) expect(collapseBefore.y).toBeGreaterThan(sidebarBefore.y + sidebarBefore.height / 2)
  // 收起按钮与设置/主题同排(位于 .side-foot .row 内),不再独占一行
  const collapseInRow = await win.evaluate(
    () => Boolean(document.querySelector('[data-testid="sidebar-collapse-btn"]')?.closest('.side-foot .row'))
  )
  expect(collapseInRow).toBe(true)
  // 展开态 logo 保持设计尺寸 28×28(此前 rail 下被 flex:0 压成 16px)
  const expandedMark = await win.evaluate(() => {
    const mark = document.querySelector('[data-testid="brand"] .brand-mark') as HTMLElement | null
    return mark ? Math.round(mark.getBoundingClientRect().width) : null
  })
  expect(expandedMark).toBe(28)
  await win.keyboard.press('Meta+b')
  await win.waitForTimeout(300)
  await win.screenshot({ path: join(SHOT_DIR, 'shell-rail.png'), animations: 'disabled' })
  const railCols = await win.evaluate(
    () => getComputedStyle(document.querySelector('[data-testid="app-shell"]') as Element).gridTemplateColumns
  )
  expect(railCols.split(' ')[0]).toBe('64px')
  await expect(win.getByTestId(`inst-${railItemId}`)).toHaveAttribute('title', '收起态留白检查')
  const collapseAfter = await win.getByTestId('sidebar-collapse-btn').boundingBox()
  const brandAfter = await win.getByTestId('brand').boundingBox()
  expect(collapseAfter).not.toBeNull()
  expect(brandAfter).not.toBeNull()
  if (collapseAfter && brandAfter) expect(collapseAfter.y).toBeGreaterThan(brandAfter.y + brandAfter.height)
  // 折叠态 logo 不得小于展开态(此前被压缩到 16px)
  const railMark = await win.evaluate(() => {
    const mark = document.querySelector('[data-testid="brand"] .brand-mark') as HTMLElement | null
    return mark ? Math.round(mark.getBoundingClientRect().width) : null
  })
  expect(railMark).not.toBeNull()
  if (railMark !== null && expandedMark !== null) expect(Math.abs(railMark - expandedMark)).toBeLessThanOrEqual(3)
  const railItem = await win.getByTestId(`inst-${railItemId}`).boundingBox()
  expect(railItem).not.toBeNull()
  if (railItem) {
    expect(railItem.x).toBeGreaterThan(0)
    expect(railItem.x + railItem.width).toBeLessThan(64)
  }
  await win.keyboard.press('Meta+b')
  await win.waitForTimeout(300)
})

test('SSH 认证对话框限制在右侧工作区且指纹复制行不溢出', async () => {
  const workspaceId = await win.evaluate(async () => {
    const created = await window.dshHub.instances.create({
      transport: 'http',
      name: 'SSH 对话框工作区范围',
      authMode: 'none',
      endpointUrl: 'https://workspace-scope.example.com/dsh'
    })
    if (!created.ok) throw new Error(created.message)
    return created.value.id
  })
  await win.reload()
  await expect(win.getByTestId(`inst-${workspaceId}`)).toBeVisible()
  await win.getByTestId(`inst-${workspaceId}`).click()
  await expect(win.getByTestId('workspace-back-btn')).toBeVisible()

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ssh:hostKeyDecision', {
      requestId: 'ui-polish-host-key',
      instanceId: 'ui-polish-instance',
      target: 'vsgp',
      verdict: 'unknown',
      fingerprints: [
        {
          type: 'ssh-ed25519',
          typeLabel: 'ED25519',
          fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789'
        }
      ],
      previousFingerprints: []
    })
  })
  await expect(win.getByTestId('fingerprint-dialog')).toBeVisible()
  const geometry = await win.evaluate(() => {
    const shell = document.querySelector('[data-testid="app-shell"]')
    const sidebar = document.querySelector('[data-testid="sidebar"]')
    const topbar = document.querySelector('.topbar')
    const overlay = document.querySelector('.overlay-workspace')
    const dialog = document.querySelector('[data-testid="fingerprint-dialog"]')
    const copy = document.querySelector('.fingerprint-copy')
    const value = document.querySelector('.fingerprint-value')
    if (!shell || !sidebar || !topbar || !overlay || !dialog || !copy || !value) return null
    const shellBox = shell.getBoundingClientRect()
    const sidebarBox = sidebar.getBoundingClientRect()
    const topbarBox = topbar.getBoundingClientRect()
    const overlayBox = overlay.getBoundingClientRect()
    const dialogBox = dialog.getBoundingClientRect()
    const copyBox = copy.getBoundingClientRect()
    const valueBox = value.getBoundingClientRect()
    return {
      shellLeft: shellBox.left,
      sidebarRight: sidebarBox.right,
      topbarBottom: topbarBox.bottom,
      overlayLeft: overlayBox.left,
      overlayTop: overlayBox.top,
      dialogRight: dialogBox.right,
      contentRight: shellBox.right,
      copyRight: copyBox.right,
      insetRight: valueBox.right
    }
  })
  expect(geometry).not.toBeNull()
  if (!geometry) return
  expect(geometry.overlayLeft).toBeGreaterThanOrEqual(geometry.sidebarRight - 1)
  expect(geometry.overlayTop).toBeGreaterThanOrEqual(geometry.topbarBottom - 1)
  expect(geometry.dialogRight).toBeLessThanOrEqual(geometry.contentRight + 1)
  expect(geometry.copyRight).toBeLessThanOrEqual(geometry.contentRight + 1)
  expect(geometry.insetRight).toBeLessThanOrEqual(geometry.copyRight + 1)
  await win.getByTestId('fingerprint-dialog').locator('.x-btn').click()
  await expect(win.getByTestId('fingerprint-dialog')).toBeHidden()
})

test('#1 向导三选项卡:间距与边框关系正常(截图目验)', async () => {
  await win.getByTestId('new-instance-btn').click()
  await expect(win.getByTestId('wizard')).toBeVisible()
  await expect(win.getByTestId('wizard-step-1')).toBeVisible()
  // 结构断言:type-cards 与 modal-head 边框之间有真实间隙(不重叠)
  const gap = await win.evaluate(() => {
    const head = document.querySelector('[data-testid="wizard"] .modal-head')
    const cards = document.querySelector('[data-testid="wizard-step-1"]')
    if (!head || !cards) return null
    const headBottom = head.getBoundingClientRect().bottom
    const cardsTop = cards.getBoundingClientRect().top
    return { headBottom, cardsTop, delta: cardsTop - headBottom }
  })
  expect(gap).not.toBeNull()
  if (!gap) return
  expect(gap.delta).toBeGreaterThan(8) // 有 ≥8px 间隙,不是贴着重叠
  await win.screenshot({ path: join(SHOT_DIR, 'wizard-step1.png'), animations: 'disabled' })
  // 关闭向导(点 ✕)
  await win.locator('[data-testid="wizard"] .x-btn').click()
  await expect(win.getByTestId('wizard')).toBeHidden()
})

test('#2/#3 认证链路:按钮状态化 + 密码屏/OTP 屏 + 无 OTP 直连 + pill hover', async () => {
  const { server, port } = await startFakeGateway(true)
  test.setTimeout(60_000)
  try {
    // 创建 OTP 网关实例(http + auto)
    const created = await win.evaluate(async (p) => {
      const r = await window.dshHub.instances.create({
        transport: 'http',
        name: 'OTP 网关实例',
        authMode: 'auto',
        endpointUrl: `http://127.0.0.1:${p}/dsh`
      })
      if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r)}`)
      const s = await window.dshHub.runtime.start(r.value.id)
      return { id: r.value.id, startOk: s.ok }
    }, port)
    expect(created.startOk).toBe(true)
    await win.waitForTimeout(600) // 探测完成(302→login → await-credentials)
    // evaluate 直创实例不经过渲染层 store → 重载让列表/详情缓存同步
    await win.reload()
    await expect(win.getByTestId('app-shell')).toBeVisible()
    await win.waitForTimeout(400)

    await win.getByTestId('instances-table').getByText('OTP 网关实例', { exact: true }).click()
    await expect(win.getByTestId('view-detail')).toBeVisible()
    // 新实例默认保存密码与会话，用户可显式取消。
    await expect(win.getByTestId('vault-remember-password')).toBeChecked()
    await expect(win.getByTestId('vault-remember-session')).toBeChecked()

    // #2:未登录态 —— 按钮是「登录」且没有「登出」
    await expect(win.getByTestId('login-btn')).toBeVisible()
    await expect(win.getByTestId('login-btn')).toContainText('登录')
    await expect(win.getByTestId('login-btn')).not.toContainText('重新登录')
    expect(await win.getByTestId('logout-btn').count()).toBe(0)
    await win.screenshot({ path: join(SHOT_DIR, 'detail-not-logged-in.png'), animations: 'disabled' })

    // #3:明文胶囊 hover 出现提示气泡
    const pill = win.getByTestId('cleartext-warning')
    if ((await pill.count()) > 0) {
      await pill.hover()
      await win.waitForTimeout(200)
      await win.screenshot({ path: join(SHOT_DIR, 'pill-hover.png'), animations: 'disabled' })
    }

    // 打开认证面板 → 密码屏
    await win.getByTestId('login-btn').click()
    await expect(win.getByTestId('auth-panel')).toBeVisible()
    await win.screenshot({ path: join(SHOT_DIR, 'auth-password.png'), animations: 'disabled' })

    // 提交密码 → 假网关 400 otp-required → OTP 屏(截图:按钮形态目验)
    await win.getByTestId('auth-password').fill('hunter2')
    await win.getByTestId('auth-submit').click()
    await expect(win.getByTestId('auth-otp')).toBeVisible({ timeout: 10_000 })
    await win.screenshot({ path: join(SHOT_DIR, 'auth-otp.png'), animations: 'disabled' })

    // 输入验证码 → 200 + cookie → connected → 面板自动关闭
    await win.getByTestId('auth-otp').fill('654321')
    await win.getByTestId('auth-submit').click()
    await expect(win.getByTestId('auth-panel')).toBeHidden({ timeout: 10_000 })

    // 已连接态 —— 「重新登录」出现,「登出」出现
    await expect(win.getByTestId('login-btn')).toContainText('重新登录')
    await expect(win.getByTestId('logout-btn')).toBeVisible()
    // 密码 + TOTP 登录成功后「凭据存储」必须就地更新,不需要进出工作区才刷新
    await expect(win.getByTestId('vault-state')).toContainText('已记住')
    await win.screenshot({ path: join(SHOT_DIR, 'detail-connected.png'), animations: 'disabled' })

    // 登出 → 回到「登录」且无登出按钮
    await win.getByTestId('logout-btn').click()
    await expect(win.getByTestId('login-btn')).toContainText('登录')
    await expect(win.getByTestId('login-btn')).not.toContainText('重新登录')
    expect(await win.getByTestId('logout-btn').count()).toBe(0)
  } finally {
    server.close()
  }

  // 无 OTP 变体:首登 200 直连 —— 不出现 TOTP 页(「实例未设置 OTP 可跳过」)
  const direct = await startFakeGateway(false)
  try {
    await win.evaluate(async (p) => {
      const r = await window.dshHub.instances.create({
        transport: 'http',
        name: '无 OTP 网关实例',
        authMode: 'auto',
        endpointUrl: `http://127.0.0.1:${p}/dsh`
      })
      if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r)}`)
      await window.dshHub.runtime.start(r.value.id)
      return r.value.id
    }, direct.port)
    await win.waitForTimeout(600)
    await win.reload()
    await expect(win.getByTestId('app-shell')).toBeVisible()
    await win.waitForTimeout(400)
    await win.getByTestId('instances-table').getByText('无 OTP 网关实例', { exact: true }).click()
    await expect(win.getByTestId('view-detail')).toBeVisible()
    await win.getByTestId('login-btn').click()
    await expect(win.getByTestId('auth-panel')).toBeVisible()
    await win.getByTestId('auth-password').fill('pw1234')
    await win.getByTestId('auth-submit').click()
    // 直接 connected:面板关闭,全程无 auth-otp 输入框
    await expect(win.getByTestId('auth-panel')).toBeHidden({ timeout: 10_000 })
    expect(await win.getByTestId('auth-otp').count()).toBe(0)
  } finally {
    direct.server.close()
  }
})
