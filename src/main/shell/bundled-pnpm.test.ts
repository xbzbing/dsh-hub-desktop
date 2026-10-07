import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializePnpmLauncher } from './bundled-pnpm'

const dirs: string[] = []
function workDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pnpm-launcher-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('materializePnpmLauncher', () => {
  it('写出 pnpm 启动器，内容指向传入的 pnpm.cjs 并钉住版本自管理为关闭', () => {
    const binDir = join(workDir(), 'pnpm-bin')
    const cliJs = '/opt/app/resources/pnpm-runtime/pnpm/bin/pnpm.cjs'
    const result = materializePnpmLauncher({ binDir, pnpmCliJs: cliJs })
    expect(result).toBe(binDir)

    const launcher = process.platform === 'win32' ? join(binDir, 'pnpm.cmd') : join(binDir, 'pnpm')
    const text = readFileSync(launcher, 'utf8')
    expect(text).toContain(cliJs)
    // 阻止自带 pnpm 因项目 packageManager 字段改用其它（可能是 Rust 原生 + shim 的）版本。
    expect(text.toLowerCase()).toContain('npm_config_manage_package_manager_versions')
    // 默认用裸 node（从继承 PATH 解析）。
    expect(text).toContain('node')

    if (process.platform !== 'win32') {
      // POSIX 启动器须可执行。
      expect((statSync(launcher).mode & 0o111) !== 0).toBe(true)
    }
  })

  it('可指定运行 pnpm.cjs 的 node 命令', () => {
    const binDir = join(workDir(), 'pnpm-bin')
    materializePnpmLauncher({ binDir, pnpmCliJs: '/x/pnpm.cjs', nodeCommand: '/custom/node' })
    const launcher = process.platform === 'win32' ? join(binDir, 'pnpm.cmd') : join(binDir, 'pnpm')
    expect(readFileSync(launcher, 'utf8')).toContain('/custom/node')
  })
})
