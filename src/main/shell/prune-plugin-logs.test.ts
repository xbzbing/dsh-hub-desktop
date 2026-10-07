import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstanceRecord } from '@shared/contracts'
import {
  PLUGIN_LOG_MAX_AGE_DAYS,
  managedDshHomes,
  prunePluginLogsForInstances,
  prunePluginOperationLogs
} from './prune-plugin-logs'

const roots: string[] = []

async function root(): Promise<string> {
  const path = join(process.cwd(), 'hub-data', `prune-plugin-logs-${crypto.randomUUID()}`)
  roots.push(path)
  await mkdir(path, { recursive: true })
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 8, 0, 0, 0)
const now = (): number => NOW

/** 在某 profile 的 logs 目录下建一个 operation-* 目录并把 mtime 设成 ageDays 天前。 */
async function makeOperation(home: string, profile: string, name: string, ageDays: number): Promise<string> {
  const dir = join(home, 'profiles', profile, '.plugin-manager', 'logs', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'pnpm.log'), '')
  const when = new Date(NOW - ageDays * DAY_MS)
  await utimes(dir, when, when)
  return dir
}

describe('prunePluginOperationLogs', () => {
  it('删除早于保留期的 operation-* 目录，保留期内的保留', async () => {
    const home = await root()
    const stale = await makeOperation(home, 'web', 'operation-stale', PLUGIN_LOG_MAX_AGE_DAYS + 1)
    const fresh = await makeOperation(home, 'web', 'operation-fresh', 1)
    // 恰好等于 cutoff（30 天）保留：mtime ≥ cutoff 不删
    const edge = await makeOperation(home, 'web', 'operation-edge', PLUGIN_LOG_MAX_AGE_DAYS)

    const removed = await prunePluginOperationLogs(home, { now })

    expect(removed).toEqual([stale])
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(edge)).toBe(true)
  })

  it('跨 profile 清理，且不触碰非 operation- 条目', async () => {
    const home = await root()
    const staleWeb = await makeOperation(home, 'web', 'operation-a', 40)
    const staleAcp = await makeOperation(home, 'acp', 'operation-b', 40)
    // 非 operation- 前缀的目录与文件：即便很旧也不碰
    const keepDir = join(home, 'profiles', 'web', '.plugin-manager', 'logs', 'keep-dir')
    await mkdir(keepDir, { recursive: true })
    await utimes(keepDir, new Date(NOW - 99 * DAY_MS), new Date(NOW - 99 * DAY_MS))
    const keepFile = join(home, 'profiles', 'web', '.plugin-manager', 'logs', 'operation-note.txt')
    await writeFile(keepFile, 'x')
    await utimes(keepFile, new Date(NOW - 99 * DAY_MS), new Date(NOW - 99 * DAY_MS))

    const removed = await prunePluginOperationLogs(home, { now })

    expect(removed.sort()).toEqual([staleWeb, staleAcp].sort())
    expect(existsSync(keepDir)).toBe(true)
    expect(existsSync(keepFile)).toBe(true)
  })

  it('profiles / logs 目录不存在时静默返回空', async () => {
    const home = await root()
    await expect(prunePluginOperationLogs(home, { now })).resolves.toEqual([])
    // 不应误创建 profiles 目录
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('maxAgeDays 可覆盖默认保留期', async () => {
    const home = await root()
    const d10 = await makeOperation(home, 'web', 'operation-d10', 10)
    const d3 = await makeOperation(home, 'web', 'operation-d3', 3)

    const removed = await prunePluginOperationLogs(home, { now, maxAgeDays: 7 })

    expect(removed).toEqual([d10])
    expect(existsSync(d3)).toBe(true)
  })
})

const ISO_ID = '11111111-1111-4111-8111-111111111111'

function localRecord(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id: ISO_ID,
    name: 'local',
    transport: 'local',
    authMode: 'auto',
    notes: null,
    createdAt: '',
    updatedAt: '',
    dshVersion: null,
    port: null,
    profile: null,
    launcher: null,
    useDefaultSpace: false,
    runCommand: null,
    autoStart: false,
    ...overrides
  } as InstanceRecord
}

describe('managedDshHomes', () => {
  it('隔离空间 → <dataRoot>/homes/<id>，公共空间 → <home>/.dsh，并去重', () => {
    const homes = managedDshHomes(
      '/data',
      [
        localRecord({ id: 'iso-1' }),
        localRecord({ id: 'default-a', useDefaultSpace: true }),
        localRecord({ id: 'default-b', useDefaultSpace: true }),
        { transport: 'http' } as InstanceRecord
      ],
      '/Users/admin'
    )
    expect(homes).toEqual([join('/data', 'homes', 'iso-1'), join('/Users/admin', '.dsh')])
  })
})

describe('prunePluginLogsForInstances', () => {
  it('清理所有本机实例 DSH_HOME 下的过期目录', async () => {
    const dataRoot = await root()
    const home = await root()
    const isoHome = join(dataRoot, 'homes', 'iso-1')
    const staleIso = await makeOperation(isoHome, 'web', 'operation-iso', 40)
    const staleDefault = await makeOperation(join(home, '.dsh'), 'web', 'operation-default', 40)
    const freshDefault = await makeOperation(join(home, '.dsh'), 'web', 'operation-fresh', 1)

    const removed = await prunePluginLogsForInstances({
      dataRoot,
      home,
      records: [localRecord({ id: 'iso-1' }), localRecord({ id: 'd', useDefaultSpace: true })],
      options: { now }
    })

    expect(removed.sort()).toEqual([staleIso, staleDefault].sort())
    expect(existsSync(staleIso)).toBe(false)
    expect(existsSync(staleDefault)).toBe(false)
    expect(existsSync(freshDefault)).toBe(true)
  })

  it('单条删除失败经 onError 上报后继续清理其余条目', async () => {
    const dataRoot = await root()
    const home = await root()
    const stale = await makeOperation(join(home, '.dsh'), 'web', 'operation-x', 40)
    await stat(stale)
    const errors: unknown[] = []

    const removed = await prunePluginLogsForInstances({
      dataRoot,
      home,
      records: [localRecord({ useDefaultSpace: true })],
      options: { now, onError: (error) => errors.push(error) }
    })

    expect(removed).toEqual([stale])
    expect(errors).toEqual([])
  })
})
