import { describe, expect, it, vi } from 'vitest'
import {
  followsSystemDsh,
  isExternalRuntime,
  isHubOwnedRuntime,
  resolveSystemDshUsage,
  usesSystemDsh,
  type SystemDshUsageQuery
} from './dsh-source-policy'

describe('usesSystemDsh（升级对象与版本检查的同一判据）', () => {
  it('非本机或非公共空间：数据不与用户终端共享 → 否', () => {
    expect(
      usesSystemDsh({
        transport: 'ssh',
        useDefaultSpace: true,
        launcher: 'dush',
        runtimeSource: 'path'
      })
    ).toBe(false)
    expect(
      usesSystemDsh({
        transport: 'http',
        useDefaultSpace: true,
        launcher: 'dush',
        runtimeSource: 'path'
      })
    ).toBe(false)
    expect(
      usesSystemDsh({
        transport: 'local',
        useDefaultSpace: false,
        launcher: 'dush',
        runtimeSource: 'path'
      })
    ).toBe(false)
  })

  it('来源已知：以实际来源为准', () => {
    const base = { transport: 'local', useDefaultSpace: true, launcher: null } as const
    expect(usesSystemDsh({ ...base, runtimeSource: 'path' })).toBe(true)
    expect(usesSystemDsh({ ...base, runtimeSource: 'hub' })).toBe(false)
    expect(usesSystemDsh({ ...base, runtimeSource: 'external' })).toBe(false)
  })

  it('未启动：自定义启动器固定跟随系统 dsh', () => {
    expect(
      usesSystemDsh({
        transport: 'local',
        useDefaultSpace: true,
        launcher: 'dush',
        runtimeSource: undefined
      })
    ).toBe(true)
    expect(
      usesSystemDsh({
        transport: 'local',
        useDefaultSpace: true,
        launcher: 'duush',
        runtimeSource: undefined
      })
    ).toBe(true)
  })

  it('未启动 + 默认启动器：以下次启动计划为准；计划缺省按「不是系统 dsh」处理', () => {
    const query: SystemDshUsageQuery = {
      transport: 'local',
      useDefaultSpace: true,
      launcher: 'dsh',
      runtimeSource: undefined
    }
    expect(usesSystemDsh({ ...query, plannedKind: 'path' })).toBe(true)
    expect(usesSystemDsh({ ...query, plannedKind: 'hub' })).toBe(false)
    expect(usesSystemDsh({ ...query, plannedKind: 'download' })).toBe(false)
    // 计划缺省时宁可升级 hub 副本，也不走系统分支误报「未找到系统默认 dsh」。
    expect(usesSystemDsh(query)).toBe(false)
  })

  it('followsSystemDsh 只认公共空间 + 自定义启动器', () => {
    expect(followsSystemDsh(true, 'dush')).toBe(true)
    expect(followsSystemDsh(true, 'duush')).toBe(true)
    expect(followsSystemDsh(true, 'dsh')).toBe(false)
    expect(followsSystemDsh(true, null)).toBe(false)
    expect(followsSystemDsh(false, 'dush')).toBe(false)
  })
})

describe('resolveSystemDshUsage（来源未知时补全启动计划）', () => {
  const deps = (installed: string[], path: { command: string; version: string } | null) => ({
    desiredVersion: null as string | null,
    listInstalledVersions: async () => installed,
    probePath: async () => path
  })

  it('未启动 + 默认启动器 + PATH 命中 → 计划 path，判定为系统 dsh 并复用探测结果', async () => {
    const decision = await resolveSystemDshUsage({
      transport: 'local',
      useDefaultSpace: true,
      launcher: 'dsh',
      runtimeSource: undefined,
      ...deps([], { command: '/usr/bin/dsh', version: '0.1.9' })
    })
    expect(decision.usesSystemDsh).toBe(true)
    expect(decision.pathRuntime?.version).toBe('0.1.9')
  })

  it('未启动 + 默认启动器 + 固定版本已在 hub → 计划 hub，不按系统 dsh 处理', async () => {
    const probePath = vi.fn(async () => ({ command: '/usr/bin/dsh', version: '0.1.9' }))
    const decision = await resolveSystemDshUsage({
      transport: 'local',
      useDefaultSpace: true,
      launcher: null,
      runtimeSource: undefined,
      ...deps(['0.1.4'], null),
      desiredVersion: '0.1.4',
      probePath
    })
    expect(decision.usesSystemDsh).toBe(false)
    expect(probePath).toHaveBeenCalledTimes(1)
  })

  it('path 来源：不读已装清单，探测一次供系统分支复用', async () => {
    const listInstalledVersions = vi.fn(async () => [] as string[])
    const probePath = vi.fn(async () => ({ command: '/usr/bin/dsh', version: '0.1.9' }))
    const decision = await resolveSystemDshUsage({
      transport: 'local',
      useDefaultSpace: true,
      launcher: null,
      runtimeSource: 'path',
      desiredVersion: null,
      listInstalledVersions,
      probePath
    })
    expect(decision).toMatchObject({ usesSystemDsh: true, pathRuntime: { version: '0.1.9' } })
    expect(listInstalledVersions).not.toHaveBeenCalled()
    expect(probePath).toHaveBeenCalledTimes(1)
  })

  it('hub / 外部来源与非公共空间：不探测、直接否', async () => {
    const listInstalledVersions = vi.fn(async () => [] as string[])
    const probePath = vi.fn(async () => null)
    const queries: SystemDshUsageQuery[] = [
      { transport: 'local', useDefaultSpace: true, launcher: null, runtimeSource: 'hub' },
      { transport: 'local', useDefaultSpace: true, launcher: null, runtimeSource: 'external' },
      { transport: 'local', useDefaultSpace: false, launcher: 'dush', runtimeSource: undefined },
      { transport: 'ssh', useDefaultSpace: true, launcher: 'dush', runtimeSource: undefined }
    ]
    for (const query of queries) {
      const decision = await resolveSystemDshUsage({
        ...query,
        desiredVersion: null,
        listInstalledVersions,
        probePath
      })
      expect(decision).toEqual({ usesSystemDsh: false, pathRuntime: null })
    }
    expect(listInstalledVersions).not.toHaveBeenCalled()
    expect(probePath).not.toHaveBeenCalled()
  })
})

describe('来源回写判定', () => {
  it('外部接管的运行时归用户所有；版本只认 hub 自己安装的副本', () => {
    expect(isExternalRuntime('external')).toBe(true)
    expect(isExternalRuntime('hub')).toBe(false)
    expect(isExternalRuntime('path')).toBe(false)
    expect(isExternalRuntime(undefined)).toBe(false)
    expect(isHubOwnedRuntime('hub')).toBe(true)
    expect(isHubOwnedRuntime(undefined)).toBe(true)
    expect(isHubOwnedRuntime('path')).toBe(false)
    expect(isHubOwnedRuntime('external')).toBe(false)
  })
})
