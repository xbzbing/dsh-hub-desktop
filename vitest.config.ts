import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Protocol integration tests run through pnpm test:contract.
    exclude: ['**/node_modules/**', 'tests/contract/**'],
    environment: 'node'
  }
})