import { defineConfig } from '@playwright/test'

// 测试语言默认钉在中文:经各用例 `...process.env` 进入 Electron 启动环境,
// 界面与工作区文案断言不随宿主系统语言漂移;显式传入同名变量仍可覆盖。
process.env['DSH_HUB_E2E_LOCALE'] ??= 'zh-CN'

// E2E 必须自洽：main/preload 一律来自 out/，若 renderer 被 ELECTRON_RENDERER_URL 指到本机
// 正在跑的 `pnpm dev` 开发服务器，就会「新 renderer + 旧 main」混用，得到与代码无关的失败。
// 统一清掉该变量，让 renderer 也从 out/ 加载（globalSetup 已先构建一次）。
delete process.env['ELECTRON_RENDERER_URL']

/**
 * 并行度：每个 spec 自己启动一个应用实例，数据目录按 spec 隔离（`DSH_HUB_DATA_DIR`），
 * 单实例锁也落在各自的数据目录上，因此可以跨 spec 并行；单文件内的用例仍串行。
 * 4 个 worker 实测把全量从 ~2m54s 压到 ~1m20s，再往上会因 CPU 争抢变慢。
 * CI 的 Linux 只在 xvfb 单屏下跑，仍按串行执行（见 .github/workflows/ci.yml）。
 */
const WORKERS = Number.parseInt(process.env['DSH_HUB_E2E_WORKERS'] ?? '4', 10)

export default defineConfig({
  testDir: 'tests/e2e',
  // 只收 `*.spec.ts`：同目录下还有 Vitest 的守卫用例（`data-dir.test.ts`），
  // 默认 testMatch 会把 `*.test.ts` 一并收集，用 Playwright 的 CJS 加载器跑 Vitest 导入会直接失败。
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: Number.isFinite(WORKERS) && WORKERS > 0 ? WORKERS : 4,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
