import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVault } from './vault'
import type { StoredSession, VaultCrypto } from './vault'

/** 可用的假加密后端(可逆的 base64 标记,便于断言「落盘不是明文」) */
function fakeCrypto(available = true): VaultCrypto {
  return {
    isAvailable: () => available,
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (payload) => {
      if (!payload.startsWith('enc:')) throw new Error('密文损坏')
      return Buffer.from(payload.slice(4), 'base64').toString('utf8')
    }
  }
}

const SESSION: StoredSession = { name: 'dsh_auth', value: 'sess-secret', expiresAt: 1_790_000_000_000 }

let dir: string
let filePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-vault-'))
  filePath = join(dir, 'vault', 'credentials.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('vault（§7.2 凭据存储策略）', () => {
  it('默认不存任何东西;只有显式 remember 才有条目', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    expect(vault.status()).toEqual({ available: true, degraded: false, instanceCount: 0 })
    expect(vault.getPassword('i1')).toBeNull()
    expect(vault.getSession('i1')).toBeNull()
    expect(vault.rememberedIds()).toEqual([])
  })

  it('密码:记住 → 读回 → 清除', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    expect(vault.hasPassword('i1')).toBe(false)
    await vault.rememberPassword('i1', 'hunter2')
    expect(vault.hasPassword('i1')).toBe(true)
    expect(vault.getPassword('i1')).toBe('hunter2')
    await vault.forgetPassword('i1')
    expect(vault.hasPassword('i1')).toBe(false)
    expect(vault.getPassword('i1')).toBeNull()
    expect(vault.rememberedIds()).toEqual([])
  })

  it('会话 Cookie:记住 → 读回(含 expiresAt)→ 清除', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    await vault.rememberSession('i1', SESSION)
    expect(vault.hasSession('i1')).toBe(true)
    expect(vault.getSession('i1')).toEqual(SESSION)
    await vault.forgetSession('i1')
    expect(vault.getSession('i1')).toBeNull()
  })

  it('落盘内容是密文(绝不出现明文密码/会话值),且文件权限 0600', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    await vault.rememberPassword('i1', 'hunter2')
    await vault.rememberSession('i1', SESSION)

    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('sess-secret')
    expect(raw).toContain('enc:')
    const parsed = JSON.parse(raw) as { version: number; items: Record<string, unknown> }
    expect(parsed.version).toBe(1)
    expect(Object.keys(parsed.items)).toEqual(['i1'])
  })

  it('重启后仍可读回(落盘 → 新实例加载)', async () => {
    const first = createVault({ filePath, crypto: fakeCrypto() })
    await first.rememberPassword('i1', 'hunter2')
    await first.rememberSession('i1', SESSION)

    const second = createVault({ filePath, crypto: fakeCrypto() })
    expect(second.getPassword('i1')).toBe('hunter2')
    expect(second.getSession('i1')).toEqual(SESSION)
  })

  it('safeStorage 不可用 → 降级为纯内存且不落盘', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto(false) })
    expect(vault.status()).toEqual({ available: false, degraded: true, instanceCount: 0 })
    await vault.rememberPassword('i1', 'hunter2')
    expect(vault.getPassword('i1')).toBe('hunter2') // 本会话可用
    // 关键:降级模式绝不把明文写到磁盘
    await expect(readFile(filePath, 'utf8')).rejects.toThrow()
  })

  it('降级模式下另一实例(模拟重启)读不到内容', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto(false) })
    await vault.rememberPassword('i1', 'hunter2')
    const restarted = createVault({ filePath, crypto: fakeCrypto(false) })
    expect(restarted.getPassword('i1')).toBeNull()
  })

  it('解密失败只丢该条目,不影响其它实例', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    await vault.rememberPassword('i1', 'p1')
    await vault.rememberPassword('i2', 'p2')

    // 篡改文件里 i1 的密文
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: Record<string, { password: string }>
    }
    parsed.items['i1']!.password = 'garbage'
    await writeFile(filePath, JSON.stringify(parsed))

    const errors: unknown[] = []
    const reopened = createVault({
      filePath,
      crypto: fakeCrypto(),
      onError: (error) => errors.push(error)
    })
    expect(reopened.getPassword('i1')).toBeNull()
    expect(errors).toHaveLength(1)
    expect(reopened.getPassword('i2')).toBe('p2')
    expect(reopened.rememberedIds()).toEqual(['i2'])
  })

  it('坏文件(非 JSON / 版本不符)视为空,不抛异常', async () => {
    await mkdir(join(dir, 'vault'), { recursive: true })
    await writeFile(filePath, 'not json at all')
    const errors: unknown[] = []
    const vault = createVault({
      filePath,
      crypto: fakeCrypto(),
      onError: (error) => errors.push(error)
    })
    expect(vault.rememberedIds()).toEqual([])
    expect(errors).toHaveLength(1)

    await writeFile(filePath, JSON.stringify({ version: 99, items: { i1: {} } }))
    const other = createVault({ filePath, crypto: fakeCrypto(), onError: () => undefined })
    expect(other.rememberedIds()).toEqual([])
  })

  it('空密码/空会话被拒绝(不写入无意义条目)', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    await expect(vault.rememberPassword('i1', '')).rejects.toThrow()
    await expect(vault.rememberSession('i1', { ...SESSION, value: '' })).rejects.toThrow()
    expect(vault.rememberedIds()).toEqual([])
  })

  it('forgetInstance 清某实例全部条目;clearAll 一键清空', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    await vault.rememberPassword('i1', 'p1')
    await vault.rememberSession('i1', SESSION)
    await vault.rememberPassword('i2', 'p2')

    await vault.forgetInstance('i1')
    expect(vault.getPassword('i1')).toBeNull()
    expect(vault.getSession('i1')).toBeNull()
    expect(vault.getPassword('i2')).toBe('p2')

    await vault.clearAll()
    expect(vault.rememberedIds()).toEqual([])
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { items: unknown }
    expect(parsed.items).toEqual({})
  })

  it('hasPassword/hasSession 不触发解密(损坏条目的存在性判断不受影响)', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    await vault.rememberPassword('i1', 'p1')
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: Record<string, { password: string }>
    }
    parsed.items['i1']!.password = 'garbage'
    await writeFile(filePath, JSON.stringify(parsed))

    const reopened = createVault({ filePath, crypto: fakeCrypto(), onError: () => undefined })
    expect(reopened.hasPassword('i1')).toBe(true)
  })
})
