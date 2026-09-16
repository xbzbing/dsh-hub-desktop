import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/** Runs integration tests against a local dsh-auth-gateway source tree. */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['tests/contract/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
