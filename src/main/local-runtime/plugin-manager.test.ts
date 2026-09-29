import { describe, expect, it, vi } from 'vitest'
import { createPluginManager } from './plugin-manager'
import type { PluginManagerOptions } from './plugin-manager'
import type { LocalInstance } from '@shared/contracts'
import type { CommandResult } from './exec-file'

const now = new Date().toISOString()

function localInstance(overrides: Partial<LocalInstance> = {}): LocalInstance {
  return {
    id: 'inst-1',
    name: 'local',
    transport: 'local',
    authMode: 'auto',
    notes: null,
    createdAt: now,
    updatedAt: now,
    dshVersion: '0.1.7-rc.2',
    port: 3080,
    profile: null,
    launcher: null,
    useDefaultSpace: false,
    runCommand: null,
    autoStart: false,
    ...overrides
  } as LocalInstance
}

/** 假安装器：只需给出一个已装 entry 供 resolveDshEntry 命中。 */
function fakeInstaller(): PluginManagerOptions['installer'] {
  return {
    listInstalled: async () => [
      { version: '0.1.7-rc.2', dir: '/runtimes/dsh-0.1.7-rc.2', entry: '/runtimes/dsh-0.1.7-rc.2/bin.js', installedAt: now }
    ],
    listAvailableVersions: async () => [],
    resolveDefaultVersion: async () => '0.1.7-rc.2',
    isInstalled: async () => true,
    install: async () => ({ version: '0.1.7-rc.2', dir: '', entry: '', installedAt: now }),
    ensureInstalled: async () => ({ version: '0.1.7-rc.2', dir: '', entry: '', installedAt: now }),
    resolveEntry: () => '/runtimes/dsh-0.1.7-rc.2/bin.js',
    hasIncompleteInstall: async () => false,
    resolveLatestVersion: async () => '0.1.7-rc.2',
    resolveGlobalPrefix: async () => null,
    installGlobal: async () => undefined,
    dispose: () => undefined
  }
}

const LIST_JSON = JSON.stringify([
  {
    name: 'dsh-profile-web',
    dependencies: {
      '@xbzbing/dsh-git-panel': {
        from: '@xbzbing/dsh-git-panel',
        version: '1.1.0',
        resolved: 'https://registry.npmjs.org/@xbzbing/dsh-git-panel/-/dsh-git-panel-1.1.0.tgz',
        path: '/node_modules/@xbzbing/dsh-git-panel'
      },
      'dsh-free-search': {
        from: 'dsh-free-search',
        version: '0.4.39',
        resolved: 'https://registry.npmjs.org/dsh-free-search/-/dsh-free-search-0.4.39.tgz',
        path: '/node_modules/dsh-free-search'
      }
    }
  }
])

const GIT_PANEL_MANIFEST = {
  name: '@xbzbing/dsh-git-panel',
  version: '1.1.0',
  description: 'Git panel',
  license: 'MIT',
  author: 'xbzbing',
  repository: { type: 'git', url: 'git+https://github.com/xbzbing/dsh-git-panel.git' },
  icon: './icon.svg',
  dependencies: {},
  peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
  engines: { node: '^22.19.0 || >=24.0.0' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }
}

const FREE_SEARCH_MANIFEST = {
  name: 'dsh-free-search',
  version: '0.4.39',
  description: 'Search',
  license: 'MIT',
  dependencies: { 'some-dep': '^1.0.0' },
  peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.7-rc.1' },
  engines: { node: '>=20' },
  dsh: { bundle: { patch: 'cordis.patch.yml' }, client: true }
}

function manifestFor(dir: string): Record<string, unknown> | null {
  if (dir.includes('git-panel')) return GIT_PANEL_MANIFEST
  if (dir.includes('free-search')) return FREE_SEARCH_MANIFEST
  return null
}

function baseOptions(run: PluginManagerOptions['run']): PluginManagerOptions {
  return {
    installer: fakeInstaller(),
    dataRoot: '/data',
    run,
    readManifest: manifestFor,
    readIcon: () => 'PHN2Zz48L3N2Zz4=',
    resolveNode: () => '/runtimes/dsh-0.1.7-rc.2/node'
  }
}

describe('createPluginManager.list', () => {
  it('解析列表并装配元数据（图标 data-uri / npm+github url / host 半 / 依赖）', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({ code: 0, stdout: LIST_JSON, stderr: '' }))
    const manager = createPluginManager(baseOptions(run))
    const plugins = await manager.list(localInstance())

    expect(plugins).toHaveLength(2)
    const gitPanel = plugins.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')!
    expect(gitPanel.version).toBe('1.1.0')
    expect(gitPanel.npmUrl).toBe('https://www.npmjs.com/package/@xbzbing/dsh-git-panel')
    expect(gitPanel.githubUrl).toBe('https://github.com/xbzbing/dsh-git-panel')
    expect(gitPanel.iconDataUri).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
    expect(gitPanel.hasHostSide).toBe(true)
    expect(gitPanel.hasClientSide).toBe(true)
    expect(gitPanel.dshPeer).toBe('>=0.1.7-rc.2')
    expect(gitPanel.installSource).toBe('npm')

    const freeSearch = plugins.find((plugin) => plugin.name === 'dsh-free-search')!
    expect(freeSearch.dependencies).toEqual(['some-dep'])
  })

  it('locale：读 locale/<lang>.json 的 meta 本地化 title/description', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({ code: 0, stdout: LIST_JSON, stderr: '' }))
    const manager = createPluginManager({
      ...baseOptions(run),
      readLocale: (p) => {
        if (p.endsWith('/locale/zh.json') && p.includes('git-panel')) {
          return { meta: { title: 'Git 面板', description: '中文简介' } }
        }
        if (p.endsWith('/locale/en.json') && p.includes('git-panel')) {
          return { meta: { title: 'Git Panel', description: 'English desc' } }
        }
        return null
      }
    })
    const zh = await manager.list(localInstance(), 'zh')
    const zhGit = zh.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')!
    expect(zhGit.title).toBe('Git 面板')
    expect(zhGit.description).toBe('中文简介')

    const en = await manager.list(localInstance(), 'en')
    const enGit = en.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')!
    expect(enGit.title).toBe('Git Panel')
    expect(enGit.description).toBe('English desc')

    // 无 locale 的插件：title=null，description 回落 package.json。
    const zhSearch = zh.find((plugin) => plugin.name === 'dsh-free-search')!
    expect(zhSearch.title).toBe(null)
    expect(zhSearch.description).toBe('Search')
  })

  it('scoped 包元数据优先读 profile 顶层 node_modules（.pnpm 虚拟 store 里 scoped 子目录不存在）', async () => {
    const readDirs: string[] = []
    const run = vi.fn(async (): Promise<CommandResult> => ({ code: 0, stdout: LIST_JSON, stderr: '' }))
    const manager = createPluginManager({
      ...baseOptions(run),
      // 只有顶层 node_modules 路径能读到 manifest；list --json 的 .pnpm path 读不到（返回 null）。
      readManifest: (dir) => {
        readDirs.push(dir)
        if (dir.includes('/.pnpm/')) return null
        if (dir.includes('git-panel')) return GIT_PANEL_MANIFEST
        return null
      }
    })
    const plugins = await manager.list(
      localInstance({ id: 'inst-1', useDefaultSpace: false, profile: null })
    )
    const gitPanel = plugins.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')!
    // 顶层路径 = <dataRoot>/homes/<id>/profiles/web/node_modules/@xbzbing/dsh-git-panel
    expect(gitPanel.version).toBe('1.1.0')
    expect(gitPanel.hasHostSide).toBe(true)
    expect(readDirs.some((dir) => dir.endsWith('/node_modules/@xbzbing/dsh-git-panel'))).toBe(true)
  })

  it('命令拼装：plugin --profile <p> list --json，DSH_HOME 为隔离空间路径', async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    const run = vi.fn(async (command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      void command
      calls.push({ args, env: opts?.env })
      return { code: 0, stdout: LIST_JSON, stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    await manager.list(localInstance({ id: 'abc', profile: 'tui' }))

    expect(calls[0]!.args).toEqual(['/runtimes/dsh-0.1.7-rc.2/bin.js', 'plugin', '--profile', 'tui', 'list', '--json'])
    expect(calls[0]!.env?.DSH_HOME).toBe('/data/homes/abc')
  })

  it('公共空间实例：DSH_HOME 为 <home>/.dsh', async () => {
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = []
    const run = vi.fn(async (command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      void command
      void args
      calls.push({ env: opts?.env })
      return { code: 0, stdout: LIST_JSON, stderr: '' }
    })
    const manager = createPluginManager({ ...baseOptions(run), homeDir: () => '/Users/me' })
    await manager.list(localInstance({ useDefaultSpace: true }))
    expect(calls[0]!.env?.DSH_HOME).toBe('/Users/me/.dsh')
  })

  it('非零退出：抛脱敏后的错误', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({ code: 1, stdout: '', stderr: 'boom' }))
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.list(localInstance())).rejects.toThrow(/失败（exit 1）：boom/)
  })
})

describe('createPluginManager.check', () => {
  it('兼容判定：latest peer 满足实例 dsh 版本', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return {
        code: 0,
        stdout: JSON.stringify({
          version: '1.2.0',
          peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
          'time.modified': '2026-09-28T11:16:59.586Z'
        }),
        stderr: ''
      }
    })
    const manager = createPluginManager(baseOptions(run))
    const check = await manager.check(localInstance(), '@xbzbing/dsh-git-panel')
    expect(check.current).toBe('1.1.0')
    expect(check.latest).toBe('1.2.0')
    expect(check.hasUpdate).toBe(true)
    expect(check.compatible).toBe(true)
    expect(check.modifiedAt).toBe('2026-09-28T11:16:59.586Z')
  })

  it('不兼容：latest peer 要求高于实例 dsh 版本', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return {
        code: 0,
        stdout: JSON.stringify({ version: '2.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } }),
        stderr: ''
      }
    })
    const manager = createPluginManager(baseOptions(run))
    const check = await manager.check(localInstance({ dshVersion: '0.1.7-rc.2' }), '@xbzbing/dsh-git-panel')
    expect(check.compatible).toBe(false)
    expect(check.dshPeer).toBe('>=0.2.0')
  })

  it('不兼容：主包满足但 dsh 子包锁 ^0.2.0-rc.1（better-sidebar 0.24.1 真实场景）', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return {
        code: 0,
        stdout: JSON.stringify({
          version: '0.24.1',
          peerDependencies: {
            react: '^18.2.0',
            '@deepseek-ai/dsh-llm': '^0.2.0-rc.1',
            '@deepseek-ai/dsh-session': '^0.2.0-rc.1'
          }
        }),
        stderr: ''
      }
    })
    const manager = createPluginManager(baseOptions(run))
    const check = await manager.check(localInstance({ dshVersion: '0.1.7-rc.2' }), '@xbzbing/dsh-git-panel')
    // 主包 peer 未声明（dshPeer=null），但子包锁 0.2 → 整体不兼容，不给升级。
    expect(check.compatible).toBe(false)
    expect(check.dshPeer).toBe(null)
  })

  it('未安装的插件 → 抛错', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({ code: 0, stdout: LIST_JSON, stderr: '' }))
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.check(localInstance(), 'nope')).rejects.toThrow(/未安装/)
  })
})

describe('createPluginManager mutations', () => {
  it('upgrade：显式版本 add name@version，返回 host 半', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    const result = await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')
    expect(result.hasHostSide).toBe(true)
    const addCall = run.mock.calls.find(([, args]) => args.includes('add'))!
    expect(addCall[1]).toContain('@xbzbing/dsh-git-panel@1.2.0')
  })

  it('remove：卸载前判 host 半', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    const result = await manager.remove(localInstance(), '@xbzbing/dsh-git-panel')
    expect(result.hasHostSide).toBe(true)
    const removeCall = run.mock.calls.find(([, args]) => args.includes('remove'))!
    expect(removeCall[1]).toContain('remove')
    expect(removeCall[1]).toContain('@xbzbing/dsh-git-panel')
  })

  it('install：spec 原样透传给 add', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    await manager.install(localInstance(), 'github:owner/repo')
    const addCall = run.mock.calls.find(([, args]) => args.includes('add'))!
    expect(addCall[1]).toContain('github:owner/repo')
  })
})
