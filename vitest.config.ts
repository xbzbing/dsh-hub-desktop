import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // 契约测试(对真实网关)单列:pnpm test:contract
    exclude: ['**/node_modules/**', 'tests/contract/**'],
    environment: 'node'
  }
})