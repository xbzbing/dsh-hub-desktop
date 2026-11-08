/**
 * E2E 全局准备：确保 Electron 二进制就位，并先构建一次，保证 `out/` 与当前源码一致。
 *
 * 所有 E2E 都启动 `out/main/index.js`（`electron .`）。若不构建，改了源码却忘了 build 就会
 * 静默地测旧产物，得到与代码无关的失败。构建很便宜（秒级），换取「测的一定是当前源码」。
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** 同步退避等待：全局准备是同步脚本，没有 await 的时机可用。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Electron 44 起二进制按需下载：`pnpm install` 不生成 `dist/`，首次 `require('electron')`
 * （Playwright 启动应用时）才现场下载。这一步放在全局准备里，而不是留给第一个用例：
 * 下载经常超过 30s 的 `beforeAll` hook 超时，CDN 偶发 5xx 时更会让第一个 spec 直接失败。
 *
 * 统一交给 `install.js`：装好时它是 no-op（核对 `dist/version` 与 `path.txt` 后直接退出），
 * 缺失时下载；只判断 `dist` 是否存在会漏掉 `path.txt` 丢失的情况。
 */
function prepareElectron(): void {
  const installer = join(process.cwd(), 'node_modules', 'electron', 'install.js')
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execFileSync(process.execPath, [installer], { stdio: 'inherit' })
      return
    } catch (error) {
      if (attempt === 3) throw error
      console.warn(`[e2e] Electron 二进制准备失败（第 ${attempt} 次），5s 后重试：`, error)
      sleepSync(5_000)
    }
  }
}

export default function globalSetup(): void {
  prepareElectron()
  // Windows 上 pnpm 是 `pnpm.cmd` 垫片：execFileSync 不经 shell 无法直接执行它（ENOENT）。
  execFileSync('pnpm', ['exec', 'electron-vite', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
}
