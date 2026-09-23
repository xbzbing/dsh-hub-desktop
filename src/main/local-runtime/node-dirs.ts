/**
 * 常见 node 安装落点清单。启动器探测与 npm 调用共用：Finder/Dock 启动的进程只继承
 * launchd 最小 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），node 目录常不在其中，
 * 调用方按此清单补齐 PATH；独立成模块供运行时探测与安装器共用，避免循环依赖。
 */
import { join } from 'node:path'

/**
 * 常见 node 落点(顺序 = 优先级)。nvm 逐版本枚举,列目录失败即跳过。
 */
export function searchNodeDirs(home: string, listDir: (path: string) => string[]): string[] {
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  const nvmRoot = join(home, '.nvm', 'versions', 'node')
  for (const entry of listDir(nvmRoot).sort().reverse()) {
    dirs.push(join(nvmRoot, entry, 'bin'))
  }
  return dirs
}
