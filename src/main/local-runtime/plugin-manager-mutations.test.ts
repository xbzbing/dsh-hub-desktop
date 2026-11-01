import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPluginManager, profileHasHmr } from './plugin-manager'
import type { ProfileBundleStore } from './profile-bundles'
import {
  baseOptions,
  fakeBundles,
  fakeRun,
  localInstance,
  okResult,
  tempRoots
} from './plugin-manager.testkit'

describe('createPluginManager mutations', () => {
  it('upgrade（HMR）：先移除旧版本再 add name@version，返回 host 半', async () => {
    const run = fakeRun()
    const manager = createPluginManager(baseOptions(run))
    const result = await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')
    expect(result.hasHostSide).toBe(true)
    const mutations = run.mock.calls
      .map(([, args]) => args)
      .filter((args) => args.includes('add') || args.includes('remove'))
    // 与 dsh 官方 updateBundle 同口径：HMR 下先停止并移除旧版本，再安装新版本。
    expect(mutations.map((args) => (args.includes('remove') ? 'remove' : 'add'))).toEqual([
      'remove',
      'add'
    ])
    expect(mutations[0]).toContain('@xbzbing/dsh-git-panel')
    expect(mutations[1]).toContain('@xbzbing/dsh-git-panel@1.2.0')
  })

  it('upgrade（HMR）：新版本安装失败 → 装回旧版本后报错', async () => {
    const run = fakeRun((args) => {
      if (args.includes('add') && args.includes('@xbzbing/dsh-git-panel@1.2.0')) {
        return { code: 1, stdout: '', stderr: 'ERR_PNPM_FETCH_500 boom' }
      }
      return okResult()
    })
    const manager = createPluginManager(baseOptions(run))
    await expect(
      manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')
    ).rejects.toThrow(/已恢复旧版本 1\.1\.0/)
    // 回滚 = 用旧版本再 add 一次（与 updateBundle 的 restore 同口径）。
    const addCalls = run.mock.calls.map(([, args]) => args).filter((args) => args.includes('add'))
    expect(addCalls[addCalls.length - 1]).toContain('@xbzbing/dsh-git-panel@1.1.0')
  })

  it('upgrade（HMR）：新版本安装失败且旧版本恢复也失败 → 报错说明插件可能已不在 profile', async () => {
    const run = fakeRun((args) => {
      if (args.includes('add')) return { code: 1, stdout: '', stderr: 'registry down' }
      return okResult()
    })
    const manager = createPluginManager(baseOptions(run))
    await expect(
      manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')
    ).rejects.toThrow(/恢复失败，插件可能已不在 profile 中/)
  })

  it('upgrade（HMR）：升级前已禁用的插件，升级后仍为禁用（重新移出加载清单）', async () => {
    const run = fakeRun()
    const bundles = fakeBundles({
      // 依赖在、加载清单外 = 已禁用。
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: ['@xbzbing/dsh-git-panel']
    })
    const manager = createPluginManager({ ...baseOptions(run), bundleStore: bundles.store })
    const result = await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')
    expect(result.application).toBe('applied')
    expect(bundles.calls).toEqual([{ name: '@xbzbing/dsh-git-panel', enabled: false }])
    expect(bundles.current.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(bundles.current.dependencies).toEqual(['@xbzbing/dsh-git-panel'])
  })

  it('upgrade（HMR）：列表读不出已装版本 → 不尝试移除，退回覆盖安装', async () => {
    // demo-plugin 没有可读的 manifest：列表里版本落到 '—'，也就无从移除与回滚。
    const run = fakeRun(
      '',
      JSON.stringify([
        {
          name: 'dsh-profile-web',
          dependencies: { 'demo-plugin': { from: 'demo-plugin' } }
        }
      ])
    )
    const manager = createPluginManager(baseOptions(run))
    const result = await manager.upgrade(localInstance(), 'demo-plugin', '1.2.0')
    expect(result.application).toBe('applied')
    expect(run.mock.calls.some(([, args]) => args.includes('remove'))).toBe(false)
    const addCall = run.mock.calls.find(([, args]) => args.includes('add'))!
    expect(addCall[1]).toContain('demo-plugin@1.2.0')
  })

  it('upgrade：显式版本 add name@version，返回 host 半', async () => {
    const run = fakeRun()
    const manager = createPluginManager(baseOptions(run))
    const result = await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')
    expect(result.hasHostSide).toBe(true)
    const addCall = run.mock.calls.find(([, args]) => args.includes('add'))!
    expect(addCall[1]).toContain('@xbzbing/dsh-git-panel@1.2.0')
  })

  it('remove：卸载前判 host 半', async () => {
    const run = fakeRun()
    const manager = createPluginManager(baseOptions(run))
    const result = await manager.remove(localInstance(), '@xbzbing/dsh-git-panel')
    expect(result.hasHostSide).toBe(true)
    const removeCall = run.mock.calls.find(([, args]) => args.includes('remove'))!
    expect(removeCall[1]).toContain('remove')
    expect(removeCall[1]).toContain('@xbzbing/dsh-git-panel')
  })

  it('profileHasHmr：web profile 与含 web-app bundle 的 profile 有 HMR，其余保守为无', () => {
    expect(profileHasHmr('web', null)).toBe(true)
    expect(profileHasHmr('my-web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])).toBe(
      true
    )
    expect(profileHasHmr('headless', ['@deepseek-ai/dsh-base'])).toBe(false)
    expect(profileHasHmr('custom', null)).toBe(false)
  })

  it('install（web/HMR）→ applied；替换已装包同样热生效（与 dsh 同口径，无重启特例）', async () => {
    const run = fakeRun()
    // 全新包名：before 里没有 new-plugin
    const fresh = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    expect((await fresh.install(localInstance(), 'new-plugin')).application).toBe('applied')

    // 已装包名（重装/替换）：dsh-hmr 按磁盘身份热重载新模块代 → 同样 applied，不要求重启。
    const replace = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    expect(
      (await replace.install(localInstance(), '@xbzbing/dsh-git-panel@1.2.0')).application
    ).toBe('applied')
  })

  it('install：无 HMR 的 profile → 即使全新包名也需重启', async () => {
    const run = fakeRun()
    const manager = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    const instance = localInstance({ profile: 'headless' })
    expect((await manager.install(instance, 'new-plugin')).application).toBe('restart-required')
  })

  it('upgrade → 走默认规则：web/HMR 下 applied（替换已装包同样热生效），无 HMR 下 restart-required', async () => {
    const run = fakeRun()
    // web profile（默认）：dsh-hmr 热重载新模块代 → applied，不因换版本要求重启。
    const web = createPluginManager({ ...baseOptions(run) })
    const webResult = await web.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')
    expect(webResult.application).toBe('applied')

    // 无 HMR 的 profile：包已装但宿主无法热重载 → 需重启。
    const headless = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    const headlessResult = await headless.upgrade(
      localInstance({ profile: 'headless' }),
      '@xbzbing/dsh-git-panel',
      '1.2.0'
    )
    expect(headlessResult.application).toBe('restart-required')
  })

  it('remove → 走默认规则：web/HMR 下 applied，无 HMR 下 restart-required', async () => {
    const run = fakeRun()
    const web = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    expect((await web.remove(localInstance(), '@xbzbing/dsh-git-panel')).application).toBe(
      'applied'
    )

    const headless = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    expect(
      (await headless.remove(localInstance({ profile: 'headless' }), '@xbzbing/dsh-git-panel'))
        .application
    ).toBe('restart-required')
  })

  it('install：profile 层 patch 显式关闭 HMR → 全新安装也要重启（保守覆盖启发式）', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'plugin-manager-hmr-'))
    tempRoots.push(dataRoot)
    // profile 'web' 本会被启发式判为有 HMR，但用户层 patch 显式关掉了它。
    const profileDir = join(dataRoot, 'homes', 'inst-1', 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n', 'utf8')

    const run = fakeRun()
    const manager = createPluginManager({
      ...baseOptions(run),
      dataRoot,
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    expect((await manager.install(localInstance(), 'new-plugin')).application).toBe(
      'restart-required'
    )
  })

  it('install：spec 原样透传给 add', async () => {
    const run = fakeRun()
    const manager = createPluginManager(baseOptions(run))
    await manager.install(localInstance(), 'github:owner/repo')
    const addCall = run.mock.calls.find(([, args]) => args.includes('add'))!
    expect(addCall[1]).toContain('github:owner/repo')
  })
})

describe('createPluginManager install：安装后启用', () => {
  const GIT_PANEL = '@xbzbing/dsh-git-panel'

  it('install(enable:false)：add 之后把真实包名移出加载清单；缺省不触碰清单', async () => {
    const order: string[] = []
    const run = fakeRun((args) => {
      if (args.includes('add')) order.push('add')
      return okResult()
    })
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base', GIT_PANEL],
      dependencies: [GIT_PANEL]
    })
    const store: ProfileBundleStore = {
      read: bundles.store.read,
      setEnabled: async (dir: string, name: string, enabled: boolean, insertAt?: number) => {
        order.push('setEnabled')
        return bundles.store.setEnabled(dir, name, enabled, insertAt)
      }
    }
    const manager = createPluginManager({ ...baseOptions(run), bundleStore: store })
    await manager.install(localInstance(), `${GIT_PANEL}@1.2.0`, { enable: false })

    expect(order).toEqual(['add', 'setEnabled'])
    expect(bundles.calls).toEqual([{ name: GIT_PANEL, enabled: false }])
    // 落到「已禁用」：移出 bundles，保留 dependency。
    expect(bundles.current.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(bundles.current.dependencies).toEqual([GIT_PANEL])

    // enable 缺省：不额外改动加载清单（保持 dsh add 的默认启用行为）。
    const untouched = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base', GIT_PANEL],
      dependencies: [GIT_PANEL]
    })
    const defaultManager = createPluginManager({
      ...baseOptions(run),
      bundleStore: untouched.store
    })
    await defaultManager.install(localInstance(), `${GIT_PANEL}@1.2.0`)
    expect(untouched.calls).toEqual([])
    expect(untouched.current.bundles).toEqual(['@deepseek-ai/dsh-base', GIT_PANEL])
  })

  it('install(enable:false)：纯 client 插件或列表里找不到包名 → 跳过禁用，不报错', async () => {
    const clientOnlyList = JSON.stringify([
      {
        name: 'dsh-profile-web',
        dependencies: {
          'client-only': {
            from: 'client-only',
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/client-only/-/client-only-1.0.0.tgz',
            path: '/node_modules/client-only'
          }
        }
      }
    ])
    const run = fakeRun('', clientOnlyList)
    const bundles = fakeBundles({ bundles: [], dependencies: ['client-only'] })
    const manager = createPluginManager({ ...baseOptions(run), bundleStore: bundles.store })

    const result = await manager.install(localInstance(), 'client-only', { enable: false })
    expect(result.hasHostSide).toBe(false)
    expect(bundles.calls).toEqual([])

    await manager.install(localInstance(), 'brand-new-plugin', { enable: false })
    expect(bundles.calls).toEqual([])
  })
})
