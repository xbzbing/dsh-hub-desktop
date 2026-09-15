/* T6 手工验收:HTTP 直连 —— 对真实 dsh / 模拟网关 / 纯静态端点分别启动实例,
   校验 §2.3 认证模式探测结论、openView 开窗、退出无残留。
   用法:cd <repo> && node ./scripts/acceptance/verify-http.cjs
   前置:pnpm build;需已安装 dsh 运行时(hub-data/verify-real/runtimes 或指定 DSH_RUNTIME_ENTRY) */
const { _electron: electron } = require('@playwright/test')
const { mkdir, rm } = require('node:fs/promises')
const { resolve } = require('node:path')
const { execSync, spawn } = require('node:child_process')
const http = require('node:http')
const { globSync } = require('node:fs')

const DATA_DIR = resolve(process.cwd(), 'hub-data', 'verify-http')
const DSH_PORT = 31001
const GATEWAY_PORT = 31002
const PLAIN_PORT = 31003
let app = null
let dshProc = null
const servers = []

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

function resolveDshEntry() {
  if (process.env.DSH_RUNTIME_ENTRY) return process.env.DSH_RUNTIME_ENTRY
  const found = globSync('hub-data/*/runtimes/dsh-*/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (found.length === 0) throw new Error('未找到已安装的 dsh 运行时;请先跑 T3 验收或设置 DSH_RUNTIME_ENTRY')
  return resolve(found[0])
}

function listen(handler, port) {
  const server = http.createServer(handler)
  servers.push(server)
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res(server)))
}

async function waitFor(loader, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await loader()
    const hit = predicate(value)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`等待超时:${label}`)
}

async function main() {
  try {
    sh(`pkill -f 'DSH_HTTP_ACCEPT' || true`)
  } catch {
    /* 无残留 */
  }
  await rm(DATA_DIR, { recursive: true, force: true })
  await mkdir(DATA_DIR, { recursive: true })

  // 1) 真实 dsh web(browser-auth 真值)
  const entry = resolveDshEntry()
  dshProc = spawn(process.execPath, ['--expose-internals', entry, '--profile', 'web', '--host', '127.0.0.1', '--port', String(DSH_PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: '/tmp/dsh-http-accept-home', DSH_HTTP_ACCEPT: '1' },
    stdio: 'ignore',
    detached: true
  })
  dshProc.unref()

  // 2) 模拟网关(302 → /login + 401 JSON)与纯静态端点
  await listen((req, res) => {
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>login</html>')
      return
    }
    res.writeHead(302, { location: '/login' })
    res.end()
  }, GATEWAY_PORT)
  await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><title>plain dsh</title></html>')
  }, PLAIN_PORT)

  await waitFor(
    async () => {
      try {
        sh(`nc -z -w1 127.0.0.1 ${DSH_PORT}`)
        return true
      } catch {
        return false
      }
    },
    (v) => v,
    30000,
    '真实 dsh 就绪'
  )
  console.log(`[ok] 真实 dsh 就绪 127.0.0.1:${DSH_PORT}`)

  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, DSH_HUB_DATA_DIR: DATA_DIR }
  })
  const hub = await app.firstWindow()
  await hub.evaluate(() => {
    window.__httpEvents = []
    window.dshHub.onInstanceStatus((e) => window.__httpEvents.push(e))
    return true
  })
  const load = () => hub.evaluate(() => window.__httpEvents)

  async function createAndStart(name, endpointUrl) {
    const created = await hub.evaluate(
      ([n, url]) => window.dshHub.instances.create({ transport: 'http', name: n, endpointUrl: url }),
      [name, endpointUrl]
    )
    if (!created.ok) throw new Error(`创建失败:${created.message}`)
    await hub.evaluate((id) => window.dshHub.runtime.start(id), created.value.id)
    const running = await waitFor(
      async () => (await load()).filter((e) => e.id === created.value.id && e.status === 'running').pop() ?? null,
      (v) => v,
      20000,
      `${name} running`
    )
    return { id: created.value.id, detail: running.detail, url: running.url }
  }

  // A) 模拟网关 → 应识别为「检测到登录认证」
  const gateway = await createAndStart('验收 · 模拟网关', `http://127.0.0.1:${GATEWAY_PORT}/`)
  if (!gateway.detail.includes('检测到登录认证')) throw new Error(`网关探测结论异常:${gateway.detail}`)
  console.log(`[ok] 模拟网关探测:${gateway.detail}`)

  // B) 纯静态端点 → 无需登录
  const plain = await createAndStart('验收 · 静态端点', `http://127.0.0.1:${PLAIN_PORT}/`)
  if (!plain.detail.includes('无需登录')) throw new Error(`静态端点探测结论异常:${plain.detail}`)
  console.log(`[ok] 静态端点探测:${plain.detail}`)

  // C) 真实 dsh(无 token)→ 应识别为 dsh 内置浏览器认证
  const real = await createAndStart('验收 · 真实 dsh', `http://127.0.0.1:${DSH_PORT}/`)
  if (!real.detail.includes('浏览器认证')) throw new Error(`真实 dsh 探测结论异常:${real.detail}`)
  console.log(`[ok] 真实 dsh 探测:${real.detail}`)

  // D) openView 应能开窗(T6 起 http 状态走 http 管理器)
  const openResult = await hub.evaluate((id) => window.dshHub.runtime.openView(id), gateway.id)
  if (!openResult.ok) throw new Error(`http openView 失败:${JSON.stringify(openResult)}`)
  const winUrl = await waitFor(
    async () => app.windows().map((w) => w.url()).find((u) => u.startsWith('http://127.0.0.1:31002')) ?? null,
    (v) => v,
    10000,
    'http 实例窗口'
  )
  console.log(`[ok] http 实例视图窗口已打开:${winUrl}`)

  // E) 不可达端点 → error
  const created = await hub.evaluate(() =>
    window.dshHub.instances.create({ transport: 'http', name: '验收 · 不可达', endpointUrl: 'http://127.0.0.1:1/' })
  )
  await hub.evaluate((id) => window.dshHub.runtime.start(id), created.value.id)
  const failed = await waitFor(
    async () => (await load()).filter((e) => e.id === created.value.id && e.status === 'error').pop() ?? null,
    (v) => v,
    15000,
    '不可达端点 error'
  )
  if (!failed.detail.includes('不可达')) throw new Error(`不可达结论异常:${failed.detail}`)
  console.log(`[ok] 不可达端点:${failed.detail}`)

  await app.close()
  console.log('[DONE] T6 真实验收通过:网关/静态/真实 dsh 三态探测 + openView + 不可达归因')
}

run()
  .catch((error) => {
    console.error('[FAIL]', error)
    process.exitCode = 1
  })
  .finally(async () => {
    if (app) {
      try {
        await app.close()
      } catch {
        /* 已关闭 */
      }
    }
    for (const server of servers) server.close()
    if (dshProc) {
      try {
        process.kill(-dshProc.pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
    try {
      sh(`pkill -f 'DSH_HTTP_ACCEPT' || true`)
    } catch {
      /* 无残留 */
    }
    await rm('/tmp/dsh-http-accept-home', { recursive: true, force: true })
  })

async function run() {
  await main()
}
