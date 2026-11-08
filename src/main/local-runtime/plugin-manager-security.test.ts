import { describe, expect, it, vi } from 'vitest'
import type { PluginSecurityReport } from '@shared/contracts'
import type { PluginSecurityChecker } from './plugin-security'
import { createPluginManager } from './plugin-manager'
import { baseOptions, fakeRun, localInstance } from './plugin-manager.testkit'

function report(verdict: PluginSecurityReport['verdict']): PluginSecurityReport {
  return {
    spec: 'demo-plugin@1.1.0',
    verdict,
    checkedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
    fingerprint: null,
    essentialComplete: verdict !== 'unavailable',
    partial: false,
    checks: [],
    findings: [],
    facts: {
      source: 'npm',
      registry: 'npmmirror',
      publisher: null,
      maintainers: [],
      publishedAt: null,
      firstPublishedAt: null,
      versionCount: null,
      downloads30d: null,
      repositoryUrl: null,
      deprecated: null,
      hasProvenance: false,
      hasRegistrySignature: false,
      unpackedSize: null,
      fileCount: null,
      directDependencies: 0,
      nonRegistryDependencies: [],
      nativeModules: [],
      installScripts: []
    }
  }
}

function checkerFor(current: PluginSecurityReport): PluginSecurityChecker & {
  check: ReturnType<typeof vi.fn>
} {
  return { check: vi.fn(async () => current) }
}

describe('plugin manager 安全检查闸门', () => {
  it('pass：不要求确认，安装继续', async () => {
    const run = fakeRun()
    const checker = checkerFor(report('pass'))
    const manager = createPluginManager({
      ...baseOptions(run),
      securityChecker: checker,
      securityEnabled: () => true
    })
    await manager.install(localInstance(), 'demo-plugin@1.1.0')
    expect(checker.check).toHaveBeenCalledOnce()
    expect(run.mock.calls.some(([, args]) => args.includes('add'))).toBe(true)
  })

  it('warn：未确认时拒绝，确认后继续', async () => {
    const run = fakeRun()
    const checker = checkerFor(report('warn'))
    const manager = createPluginManager({
      ...baseOptions(run),
      securityChecker: checker,
      securityEnabled: () => true
    })
    await expect(manager.install(localInstance(), 'demo-plugin@1.1.0')).rejects.toThrow(
      '安全检查需要确认'
    )
    expect(run.mock.calls.some(([, args]) => args.includes('add'))).toBe(false)

    await manager.install(localInstance(), 'demo-plugin@1.1.0', {
      securityAcknowledged: true
    })
    expect(run.mock.calls.some(([, args]) => args.includes('add'))).toBe(true)
  })

  it('blocked：即使确认也拒绝，不执行 add', async () => {
    const run = fakeRun()
    const checker = checkerFor(report('blocked'))
    const manager = createPluginManager({
      ...baseOptions(run),
      securityChecker: checker,
      securityEnabled: () => true
    })
    await expect(
      manager.install(localInstance(), 'demo-plugin@1.1.0', { securityAcknowledged: true })
    ).rejects.toThrow('已阻止安装')
    expect(run.mock.calls.some(([, args]) => args.includes('add'))).toBe(false)
  })

  it('设置关闭：返回 disabled，不调用检查器，安装继续', async () => {
    const run = fakeRun()
    const checker = checkerFor(report('blocked'))
    const manager = createPluginManager({
      ...baseOptions(run),
      securityChecker: checker,
      securityEnabled: () => false
    })
    await expect(
      manager.securityCheck(localInstance(), 'demo-plugin@1.1.0')
    ).resolves.toMatchObject({ verdict: 'disabled' })
    expect(checker.check).not.toHaveBeenCalled()
    await manager.install(localInstance(), 'demo-plugin@1.1.0')
    expect(run.mock.calls.some(([, args]) => args.includes('add'))).toBe(true)
  })

  it('upgrade：warn 未确认不发 remove/add；确认后执行升级', async () => {
    const run = fakeRun()
    const checker = checkerFor(report('warn'))
    const manager = createPluginManager({
      ...baseOptions(run),
      securityChecker: checker,
      securityEnabled: () => true
    })
    await expect(
      manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')
    ).rejects.toThrow('安全检查需要确认')
    expect(run.mock.calls.some(([, args]) => args.includes('remove'))).toBe(false)

    await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0', {
      securityAcknowledged: true
    })
    expect(run.mock.calls.some(([, args]) => args.includes('add'))).toBe(true)
  })

  it('upgrade：blocked 在删除旧版本之前拒绝', async () => {
    const run = fakeRun()
    const checker = checkerFor(report('blocked'))
    const manager = createPluginManager({
      ...baseOptions(run),
      securityChecker: checker,
      securityEnabled: () => true
    })
    await expect(
      manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0', {
        securityAcknowledged: true
      })
    ).rejects.toThrow('已阻止安装')
    expect(run.mock.calls.some(([, args]) => args.includes('remove'))).toBe(false)
  })
})
