import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 契约测试配置(T7):只跑 tests/contract/**,对**真实** dsh-auth-gateway 验证协议。
 * 与单测分离是因为它需要本机网关源码(DSH_AUTH_GATEWAY_SRC,缺省 /Users/dev/workspace/private/dsh-auth-gateway)。
 */
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
