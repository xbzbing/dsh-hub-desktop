import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from './runtime-installer'
import {
  createRuntimeInstaller,
  readInstallingMarker,
  runtimeDirFor,
  runtimeEntryFor,
  type InstalledRuntime
} from './runtime-installer'

let dirs: string[] = []
const tmpDir = (): string => {
  const dir = join(process.cwd(), 'hub-data', 'test-tmp', `rt-${randomUUID().slice(0, 8)}`)
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

function okRun(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: '' }
}

/** 造一个「已安装」的运行时目录,让入口存在性校验通过 */
async function fakeInstallArtifacts(runtimesDir: string, version: string): Promise<string> {
  const entry = runtimeEntryFor(runtimesDir, version)
  await mkdir(join(runtimeDirFor(runtimesDir, version), 'node_modules', '@deepseek-ai', 'dsh', 'lib'), {
    recursive: true
  })
  await writeFile(entry, '#!/usr/bin/env node\n', 'utf8')
  return entry
}

describe('createRuntimeInstaller', () => {
  it('listAvailableVersions 解析 npm view 输出(剔除非字符串/含斜杠项)', async () => {
    const run = vi.fn(async () =>
      okRun(JSON.stringify(['0.1.2-rc.1', '0.1.5-rc.1', '0.1.5-rc.2', { bad: 1 }, 'x/y']))
    )
    const installer = createRuntimeInstaller({ runtimesDir: tmpDir(), cacheDir: tmpDir(), run })
    const versions = await installer.listAvailableVersions()
    expect(versions).toEqual(['0.1.2-rc.1', '0.1.5-rc.1', '0.1.5-rc.2'])
    expect(run).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining(['view', '@deepseek-ai/dsh', 'versions', '--json'])
    )
  })

  it('resolveDefaultVersion 优先 dist-tags.latest,否则取版本列表末位', async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) =>
      args.includes('dist-tags')
        ? okRun(JSON.stringify({ latest: '0.1.5-rc.1', next: '0.1.5-rc.2' }))
        : okRun(JSON.stringify(['0.1.2-rc.1', '0.1.5-rc.2']))
    )
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: run as never
    })
    expect(await installer.resolveDefaultVersion()).toBe('0.1.5-rc.1')

    const noTags = vi.fn(async () => okRun(JSON.stringify(['0.1.2-rc.1', '0.1.5-rc.2'])))
    const fallback = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: noTags as never
    })
    expect(await fallback.resolveDefaultVersion()).toBe('0.1.5-rc.2')
  })

  it('install 流程:写 installing.json → npm install → 校验入口 → 移除标记', async () => {
    const version = '0.1.5-rc.1'
    const runtimesDir = tmpDir()
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run: async () => okRun('')
    })
    const entry = await fakeInstallArtifacts(runtimesDir, version)

    const installed = await installer.install(version)
    expect(installed).toMatchObject({ version, dir: runtimeDirFor(runtimesDir, version), entry })
    expect(await installer.isInstalled(version)).toBe(true)
    expect(await installer.hasIncompleteInstall(version)).toBe(false)
  })

  it('install 失败时保留 installing.json(断点恢复依据)', async () => {
    const version = '0.1.5-rc.1'
    const runtimesDir = tmpDir()
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run: async () => ({ code: 1, stdout: '', stderr: 'EACCES 模拟' })
    })
    await expect(installer.install(version)).rejects.toThrow(/失败/)
    expect(await installer.hasIncompleteInstall(version)).toBe(true)
    expect(await readInstallingMarker(runtimesDir, version)).toMatchObject({ version })
  })

  it('install 成功后遇到入口缺失视为已安装(stat 校验)', async () => {
    // 已通过 fakeInstallArtifacts 造好入口 → isInstalled 直接为 true
    const runtimesDir = tmpDir()
    const installer = createRuntimeInstaller({ runtimesDir, cacheDir: tmpDir(), run: async () => okRun('') })
    await fakeInstallArtifacts(runtimesDir, '0.1.5-rc.2')
    expect(await installer.isInstalled('0.1.5-rc.2')).toBe(true)
    expect(await installer.isInstalled('0.1.4-rc.1')).toBe(false)
  })

  it('非法版本号(路径穿越)一律拒绝', async () => {
    const installer = createRuntimeInstaller({ runtimesDir: tmpDir(), cacheDir: tmpDir() })
    await expect(installer.install('1.0.0/../../evil')).rejects.toThrow(/非法版本号/)
    await expect(installer.isInstalled('../x')).rejects.toThrow(/非法版本号/)
    expect(() => runtimeDirFor(tmpDir(), 'a/b')).toThrow(/非法版本号/)
    expect(() => runtimeEntryFor(tmpDir(), 'a\\b')).toThrow(/非法版本号/)
  })

  it('listInstalled 跳过未完成安装与无关目录名', async () => {
    const runtimesDir = tmpDir()
    const installer = createRuntimeInstaller({ runtimesDir, cacheDir: tmpDir(), run: async () => okRun('') })
    await fakeInstallArtifacts(runtimesDir, '0.1.5-rc.1')

    // 手工制造「未完成」目录与无关目录
    const broken = join(runtimesDir, 'dsh-0.1.4-rc.1')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'installing.json'), '{}', 'utf8')
    await mkdir(join(runtimesDir, '无关目录'), { recursive: true })

    const installed = await installer.listInstalled()
    expect(installed.map((item: InstalledRuntime) => item.version)).toEqual(['0.1.5-rc.1'])
  })
})