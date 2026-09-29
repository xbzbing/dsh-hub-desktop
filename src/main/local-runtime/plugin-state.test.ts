import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginStateStore } from './plugin-state'

const dirs: string[] = []
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-state-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('createPluginStateStore', () => {
  it('未写过时返回空状态（lastCheckedAt=null，无更新项）', async () => {
    const store = createPluginStateStore(await tempRoot())
    expect(await store.read('inst-1')).toEqual({ lastCheckedAt: null, updates: {} })
  })

  it('写入后可读回（含插件检查摘要）', async () => {
    const store = createPluginStateStore(await tempRoot())
    await store.write('inst-1', {
      lastCheckedAt: '2026-09-29T10:00:00.000Z',
      updates: {
        'dsh-better-sidebar': {
          latest: '0.24.1',
          compatible: true,
          dshPeer: '^0.2.0-rc.1',
          dshVersion: '0.2.0-rc.1',
          modifiedAt: '2026-09-28T15:37:38.655Z'
        }
      }
    })
    const state = await store.read('inst-1')
    expect(state.lastCheckedAt).toBe('2026-09-29T10:00:00.000Z')
    expect(state.updates['dsh-better-sidebar']?.latest).toBe('0.24.1')
    expect(state.updates['dsh-better-sidebar']?.compatible).toBe(true)
  })

  it('不同实例互不影响', async () => {
    const store = createPluginStateStore(await tempRoot())
    await store.write('inst-1', { lastCheckedAt: 'a', updates: {} })
    expect(await store.read('inst-2')).toEqual({ lastCheckedAt: null, updates: {} })
  })

  it('文件损坏或字段类型不对时按空状态处理，不抛错', async () => {
    const root = await tempRoot()
    const store = createPluginStateStore(root)
    // 非法 JSON
    await store.write('broken', { lastCheckedAt: null, updates: {} })
    await writeFile(join(root, 'plugin-state', 'broken.json'), '{not json', 'utf8')
    expect(await store.read('broken')).toEqual({ lastCheckedAt: null, updates: {} })

    // 脏字段：缺 latest 的项被丢弃，其余保留
    await writeFile(
      join(root, 'plugin-state', 'dirty.json'),
      JSON.stringify({ lastCheckedAt: 42, updates: { ok: { latest: '1.0.0' }, bad: { compatible: true } } }),
      'utf8'
    )
    const dirty = await store.read('dirty')
    expect(dirty.lastCheckedAt).toBeNull()
    expect(Object.keys(dirty.updates)).toEqual(['ok'])
    expect(dirty.updates.ok?.compatible).toBe(true)
  })
})
