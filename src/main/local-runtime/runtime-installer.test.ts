import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult, NpmInvocation } from './runtime-installer'
import {
  createRuntimeInstaller,
  npmFetchPath,
  readInstallingMarker,
  resolveNpmInvocation,
  runtimeDirFor,
  runtimeEntryFor,
  spawnNpm,
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
    // npm 解析注入固定值:聚焦 view 输出解析,断言不随宿主平台探测结果漂移
    const run = vi.fn(async () => okRun(JSON.stringify(['0.1.2-rc.1', '0.1.5-rc.1', '0.1.5-rc.2', { bad: 1 }, 'x/y'])))
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run,
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] })
    })
    const versions = await installer.listAvailableVersions()
    expect(versions).toEqual(['0.1.2-rc.1', '0.1.5-rc.1', '0.1.5-rc.2'])
    expect(run).toHaveBeenCalledWith(
      '/fake/npm',
      expect.arrayContaining(['view', '@deepseek-ai/dsh', 'versions', '--json']),
      expect.anything()
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

  it('resolveLatestVersion 取版本列表最大值(dist-tags.latest 滞后于新发布也不受影响)', async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) =>
      args.includes('dist-tags')
        ? okRun(JSON.stringify({ latest: '0.1.5-rc.2' }))
        : okRun(JSON.stringify(['0.1.5-rc.2', '0.1.6-alpha.2', '0.1.7-alpha.2']))
    )
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: run as never
    })
    expect(await installer.resolveLatestVersion()).toBe('0.1.7-alpha.2')

    // 不假设 registry 返回顺序：乱序也按版本比较取最大。
    const unordered = vi.fn(async (_cmd: string, args: string[]) =>
      args.includes('dist-tags')
        ? okRun('{}')
        : okRun(JSON.stringify(['0.1.7-alpha.2', '0.1.5-rc.4', '0.1.6']))
    )
    const shuffled = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: unordered as never
    })
    expect(await shuffled.resolveLatestVersion()).toBe('0.1.7-alpha.2')
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

  it('isInstalled 按入口存在性 stat 判断:有入口→已安装,无入口/无目录→未安装', async () => {
    // 已通过 fakeInstallArtifacts 造好 0.1.5-rc.2 的入口;0.1.4-rc.1 目录与入口都不存在。
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

  it('ensureInstalled 并发只安装一次(多实例同时首启复用同一份运行时)', async () => {
    const runtimesDir = tmpDir()
    const version = '0.1.5-rc.1'
    let installCalls = 0
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run: async (_command: string, args: string[]) => {
        if (args.includes('install')) {
          installCalls += 1
          await fakeInstallArtifacts(runtimesDir, version)
          return okRun('')
        }
        return okRun('[]')
      }
    })

    const [first, second] = await Promise.all([
      installer.ensureInstalled(version),
      installer.ensureInstalled(version)
    ])
    expect(installCalls).toBe(1)
    expect(first.entry).toBe(second.entry)
    expect(await installer.isInstalled(version)).toBe(true)
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

  it('ensureInstalled 进度分支:stderr fetch 行驱动 onProgress(经 runNpm 注入覆盖生产路径)', async () => {
    const version = '0.1.5-rc.1'
    const runtimesDir = tmpDir()
    const run = vi.fn(async () => okRun('[]'))
    const runNpm = vi.fn(async (
      _npm: NpmInvocation,
      _args: string[],
      opts: { onStderrLine?: (line: string) => void }
    ) => {
      opts.onStderrLine?.('npm http fetch GET 200 https://registry.npmjs.org/a 1ms (cache miss)')
      opts.onStderrLine?.('npm http fetch GET 200 https://registry.npmjs.org/b/-/b-1.0.0.tgz 2ms (cache miss)')
      opts.onStderrLine?.('added 2 packages')
      await fakeInstallArtifacts(runtimesDir, version)
      return okRun('')
    })
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run,
      runNpm,
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] })
    })

    const details: Array<string | undefined> = []
    await installer.ensureInstalled(version, (progress) => details.push(progress.detail))

    expect(details[0]).toBe(`安装 @deepseek-ai/dsh@${version}`)
    expect(details).toContain('下载依赖 (1)：a')
    expect(details).toContain('下载依赖 (2)：b/-/b-1.0.0.tgz')
    // 非 fetch 行不推进进度
    expect(details.filter((detail) => detail?.includes('added'))).toHaveLength(0)
  })

  it('进度分支失败:错误消息只保留 stderr 尾部结论(http 日志不整段进入消息)', async () => {
    const runtimesDir = tmpDir()
    const run = vi.fn(async () => okRun('[]'))
    const stderrLines = [
      ...Array.from({ length: 40 }, (_, index) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${index} 1ms`),
      'npm error 404 Not Found'
    ]
    const runNpm = vi.fn(async (
      _npm: NpmInvocation,
      _args: string[],
      opts: { onStderrLine?: (line: string) => void }
    ) => {
      for (const line of stderrLines) opts.onStderrLine?.(line)
      return { code: 1, stdout: '', stderr: stderrLines.join('\n') }
    })
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run,
      runNpm,
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] })
    })

    const message = await installer
      .ensureInstalled('0.1.5-rc.1', () => undefined)
      .catch((error: Error) => error.message)
    expect(message).toContain('npm error 404 Not Found')
    expect(message).not.toContain('pkg-0')
  })
})

describe('npmFetchPath', () => {
  it('完成行提取相对路径(状态码在 URL 之前)', () => {
    expect(npmFetchPath('npm http fetch GET 200 https://registry.npmjs.org/is-odd 772ms (cache miss)')).toBe('is-odd')
    expect(npmFetchPath('npm http fetch GET 200 https://registry.npmmirror.com/dsh 1ms')).toBe('dsh')
  })

  it('请求行与非 fetch 行返回 null', () => {
    expect(npmFetchPath('npm http fetch GET https://registry.npmjs.org/x')).toBeNull()
    expect(npmFetchPath('npm http fetch POST 200 https://registry.npmjs.org/-/user 5ms')).toBeNull()
    expect(npmFetchPath('added 2 packages in 4s')).toBeNull()
  })
})

describe('spawnNpm', () => {
  it('收集 stdout/stderr,stderr 逐行回调(跨 chunk 行缓冲)', async () => {
    const lines: string[] = []
    const script = [
      "process.stderr.write('npm http fetch GET 200 https://registry.npmmir')",
      "setTimeout(() => {",
      "  process.stderr.write('ror.com/x 1ms\\ndone-line\\n')",
      "  process.stdout.write('OUT')",
      '}, 20)'
    ].join(';')
    const result = await spawnNpm({ command: process.execPath, prefixArgs: ['-e', script] }, [], {
      env: process.env,
      onStderrLine: (line) => lines.push(line)
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('OUT')
    expect(result.stderr).toContain('done-line')
    expect(lines).toEqual(['npm http fetch GET 200 https://registry.npmmirror.com/x 1ms', 'done-line'])
  })

  it('启动失败时 reject(与 runCommand 语义一致)', async () => {
    await expect(
      spawnNpm({ command: 'dsh-hub-no-such-binary', prefixArgs: [] }, [], { env: process.env })
    ).rejects.toThrow()
  })
})

describe('resolveNpmInvocation (win32)', () => {
  it('返回 node.exe 直跑自带 npm-cli.js,绝不返回 .cmd', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      // 用同一 join 构造期望路径:POSIX 下 join 产生混合分隔符,与实现一致
      const nodeExe = join('C:\\Program Files', 'nodejs', 'node.exe')
      const bundledCli = join('C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      const exists = vi.fn((path: string) => path === nodeExe || path === bundledCli)
      const invocation = await resolveNpmInvocation(vi.fn(), exists)
      expect(invocation).toEqual({ command: nodeExe, prefixArgs: [bundledCli] })
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('node.exe 与 npm-cli.js 不成对出现时返回 null(不落到 .cmd)', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const invocation = await resolveNpmInvocation(vi.fn(), () => false)
      expect(invocation).toBeNull()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})
describe('resolveNpmInvocation (unix)', () => {
  it('PATH 与 which 都找不到时，从常见安装位置解析 npm（如 homebrew）', async () => {
    // 该分支只在 Unix 语义下存在；测试在任意宿主平台固定 platform 后执行
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      // Windows 宿主上 join 产生反斜杠，与实现一致，比较前统一为正斜杠
      const posix = (path: string): string => path.replace(/\\/g, '/')
      const exists = (path: string): boolean => posix(path) === '/opt/homebrew/bin/npm'
      const run = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }))
      const invocation = await resolveNpmInvocation(run, exists)
      expect(invocation).not.toBeNull()
      expect(posix(invocation!.command)).toBe('/opt/homebrew/bin/npm')
      expect(invocation!.prefixArgs).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})

describe('npm 子进程 PATH（GUI 启动时 node 不在 PATH 的场景）', () => {
  const pathDirs = (path: string | undefined): string[] => (path ?? '').split(delimiter)
  const envOf = (call: unknown[] | undefined): NodeJS.ProcessEnv =>
    (call?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env ?? {}

  it('view 调用：npm 目录与常见 node 落点前置，原 PATH 目录全部保留', async () => {
    const run = vi.fn(async () => okRun(JSON.stringify(['0.1.5'])))
    const command = join('/opt', 'custom', 'npm')
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run,
      resolveNpm: async () => ({ command, prefixArgs: [] })
    })
    await installer.listAvailableVersions()

    const dirs = pathDirs(envOf(run.mock.calls[0]).PATH)
    // npm 自身目录在最前：PATH 缺它时 npm 入口脚本的 `#!/usr/bin/env node` 解析不到 node
    expect(dirs[0]).toBe(dirname(command))
    // 常见 node 落点兜底：npm 与 node 不在同目录时仍能找到 node
    expect(dirs).toContain(join(homedir(), '.local', 'bin'))
    expect(dirs).toContain('/opt/homebrew/bin')
    for (const original of pathDirs(process.env.PATH)) expect(dirs).toContain(original)
  })

  it('install 调用（无进度走 run、进度走 runNpm）同样带上增强后的 PATH', async () => {
    const version = '0.1.5-rc.1'
    const command = join('/opt', 'custom', 'npm')
    const resolveNpm = async () => ({ command, prefixArgs: [] })

    // 无进度分支
    const plainDir = tmpDir()
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('install')) await fakeInstallArtifacts(plainDir, version)
      return okRun('')
    })
    const plain = createRuntimeInstaller({ runtimesDir: plainDir, cacheDir: tmpDir(), run, resolveNpm })
    await plain.install(version)
    const installCall = run.mock.calls.find(([, args]) => (args as string[]).includes('install'))
    expect(pathDirs(envOf(installCall).PATH)[0]).toBe(dirname(command))

    // 进度分支
    const progressDir = tmpDir()
    let progressPath: string | undefined
    const runNpm = vi.fn(async (
      _npm: NpmInvocation,
      _args: string[],
      opts: { env: NodeJS.ProcessEnv }
    ) => {
      progressPath = opts.env.PATH
      await fakeInstallArtifacts(progressDir, version)
      return okRun('')
    })
    const progress = createRuntimeInstaller({
      runtimesDir: progressDir,
      cacheDir: tmpDir(),
      run: vi.fn(async () => okRun('')),
      runNpm,
      resolveNpm
    })
    await progress.ensureInstalled(version, () => undefined)
    expect(pathDirs(progressPath)[0]).toBe(dirname(command))
  })
})

describe('元数据读取提速（分队列 + TTL 缓存）', () => {
  const viewCount = (run: ReturnType<typeof vi.fn>): number =>
    run.mock.calls.filter(([, args]) => (args as string[]).includes('view')).length

  it('元数据读取不排在安装链后面：安装挂起时版本列表仍立即返回', async () => {
    const runtimesDir = tmpDir()
    const version = '0.1.5-rc.1'
    let releaseInstall!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'which') return okRun('/usr/local/bin/npm')
      if (args.includes('view')) return okRun(JSON.stringify([version]))
      if (args.includes('install')) {
        await gate
        await fakeInstallArtifacts(runtimesDir, version)
        return okRun('')
      }
      return okRun('')
    })
    const installer = createRuntimeInstaller({ runtimesDir, cacheDir: tmpDir(), run })

    // 安装占住安装链并卡在 gate 上。
    const installing = installer.install(version)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 若元数据与安装同队，这一行会一直挂到 gate 放开（测试超时即失败）。
    await expect(installer.listAvailableVersions()).resolves.toEqual([version])

    releaseInstall()
    await installing
  })

  it('versions 列表在 TTL 内只打一次 npm view；metadataTtlMs=0 时每次都打', async () => {
    const cachedRun = vi.fn(async (cmd: string) =>
      cmd === 'which' ? okRun('/usr/local/bin/npm') : okRun(JSON.stringify(['0.1.5']))
    )
    const cached = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: cachedRun
    })
    await cached.listAvailableVersions()
    await cached.listAvailableVersions()
    expect(viewCount(cachedRun)).toBe(1)

    const freshRun = vi.fn(async (cmd: string) =>
      cmd === 'which' ? okRun('/usr/local/bin/npm') : okRun(JSON.stringify(['0.1.5']))
    )
    const uncached = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: freshRun,
      metadataTtlMs: 0
    })
    await uncached.listAvailableVersions()
    await uncached.listAvailableVersions()
    expect(viewCount(freshRun)).toBe(2)
  })

  it('registry 变化（切镜像）后缓存立即失效，且调用带上新 --registry', async () => {
    let registry = 'https://mirror-a.example'
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'which') return okRun('/usr/local/bin/npm')
      if (args.includes('view')) return okRun(JSON.stringify(['0.1.5']))
      return okRun('')
    })
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run,
      getRegistry: () => registry
    })
    await installer.listAvailableVersions()
    await installer.listAvailableVersions()
    expect(viewCount(run)).toBe(1)

    registry = 'https://mirror-b.example'
    await installer.listAvailableVersions()
    expect(viewCount(run)).toBe(2)
    expect(run.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining(['--registry', 'https://mirror-b.example'])
    )
  })
})
