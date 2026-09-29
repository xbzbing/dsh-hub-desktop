/**
 * E2E 全局准备：先构建一次，保证 `out/` 与当前源码一致。
 *
 * 所有 E2E 都启动 `out/main/index.js`（`electron .`）。若不构建，改了源码却忘了 build 就会
 * 静默地测旧产物，得到与代码无关的失败。构建很便宜（秒级），换取「测的一定是当前源码」。
 */
import { execFileSync } from 'node:child_process'

export default function globalSetup(): void {
  execFileSync('pnpm', ['exec', 'electron-vite', 'build'], { stdio: 'inherit' })
}
