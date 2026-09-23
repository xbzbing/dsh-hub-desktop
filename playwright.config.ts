import { defineConfig } from '@playwright/test'

// 测试语言默认钉在中文:经各用例 `...process.env` 进入 Electron 启动环境,
// 界面与工作区文案断言不随宿主系统语言漂移;显式传入同名变量仍可覆盖。
process.env['DSH_HUB_E2E_LOCALE'] ??= 'zh-CN'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: 0,
  /** Electron tests share one application instance. */
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})