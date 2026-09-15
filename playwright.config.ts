import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: 0,
  /** Electron 单实例，串行执行 */
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})