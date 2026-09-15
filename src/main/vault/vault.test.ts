import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VAULT_POLICY, createVault } from './vault'
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

const SESSION: StoredSession = {
  name: 'dsh_auth',
  value: 'sess-secret',
  expiresAt: 1_790_000_000_000
}

const BOTH = { rememberPassword: true, rememberSession: true }

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

/** 勾选「两个都记住」后的 vault(§7.2:显式勾选是落盘的前置条件) */
async function optIn(
  overrides: Partial<typeof BOTH> = {},
  available = true
): Promise<ReturnType<typeof createVault>> {
  const vault = createVault({ filePath, crypto: fakeCrypto(available) })
  await vault.setPolicy('i1', { ...BOTH, ...overrides })
  return vault
}

describe('vault（§7.2 凭据存储策略）', () => {
  it('默认不存任何东西,且默认策略是「都不记住」', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    expect(vault.status()).toEqual({ available: true, degraded: false, instanceCount: 0 })
    // 字面量断言(而非与 DEFAULT 自比):默认值本身是安全相关常量,必须被钉住
    expect(vault.getPolicy('i1')).toEqual({ rememberPassword: false, rememberSession: false })
    expect(DEFAULT_VAULT_POLICY).toEqual({ rememberPassword: false, rememberSession: false })
    expect(vault.getPassword('i1')).toBeNull()
    expect(vault.getSession('i1')).toBeNull()
    expect(vault.rememberedIds()).toEqual([])
  })

  it('未勾选时拒绝落盘(显式勾选是硬性前置条件,不依赖调用方自觉)', async () => {
    const vault = createVault({ filePath, crypto: fakeCrypto() })
    await expect(vault.rememberPassword('i1', 'hunter2')).rejects.toThrow()
    await expect(vault.rememberSession('i1', SESSION)).rejects.toThrow()
    expect(vault.rememberedIds()).toEqual([])
    await expect(readFile(filePath, 'utf8')).rejects.toThrow()
  })

  it('勾选后:密码 记住 → 读回 → 清除', async () => {
    const vault = await optIn()
    expect(vault.hasPassword('i1')).toBe(false)
    await vault.rememberPassword('i1', 'hunter2')
    expect(vault.hasPassword('i1')).toBe(true)
    expect(vault.getPassword('i1')).toBe('hunter2')
    await vault.forgetPassword('i1')
    expect(vault.hasPassword('i1')).toBe(false)
    expect(vault.getPassword('i1')).toBeNull()
  })

  it('勾选后:会话 Cookie 记住 → 读回(含 expiresAt)→ 清除', async () => {
    const vault = await optIn()
    await vault.rememberSession('i1', SESSION)
    expect(vault.hasSession('i1')).toBe(true)
    expect(vault.getSession('i1')).toEqual(SESSION)
    await vault.forgetSession('i1')
    expect(vault.getSession('i1')).toBeNull()
  })

  it('落盘内容是密文(绝不出现明文密码/会话值)', async () => {
    const vault = await optIn()
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

  it('落盘文件权限为 0600', async () => {
    const vault = await optIn()
    await vault.rememberPassword('i1', 'hunter2')
    const info = await stat(filePath)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('重启后:条目与勾选策略都还在(落盘 → 新实例加载)', async () => {
    const first = await optIn()
    await first.rememberPassword('i1', 'hunter2')
    await first.rememberSession('i1', SESSION)

    const second = createVault({ filePath, crypto: fakeCrypto() })
    expect(second.getPassword('i1')).toBe('hunter2')
    expect(second.getSession('i1')).toEqual(SESSION)
    expect(second.getPolicy('i1')).toEqual(BOTH)
  })

  it('取消勾选必须真的忘掉(不只是停止「继续记住」)', async () => {
    const vault = await optIn()
    await vault.rememberPassword('i1', 'hunter2')
    await vault.rememberSession('i1', SESSION)

    await vault.setPolicy('i1', { rememberPassword: false, rememberSession: true })
    expect(vault.getPassword('i1')).toBeNull()
    expect(vault.getSession('i1')).toEqual(SESSION)

    await vault.setPolicy('i1', { rememberPassword: false, rememberSession: false })
    expect(vault.getSession('i1')).toBeNull()
    // 字面量断言(而非与 DEFAULT 自比):默认值本身是安全相关常量,必须被钉住
    expect(vault.getPolicy('i1')).toEqual({ rememberPassword: false, rememberSession: false })
    expect(DEFAULT_VAULT_POLICY).toEqual({ rememberPassword: false, rememberSession: false })
    expect(vault.rememberedIds()).toEqual([])

    // 落盘文件里也不再有密文
    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('enc:')
  })

  it('safeStorage 不可用 → 降级为纯内存且不落盘', async () => {
    const vault = await optIn({}, false)
    expect(vault.status()).toEqual({ available: false, degraded: true, instanceCount: 0 })
    await vault.rememberPassword('i1', 'hunter2')
    expect(vault.getPassword('i1')).toBe('hunter2') // 本会话可用
    // 关键:降级模式绝不把明文写到磁盘
    await expect(readFile(filePath, 'utf8')).rejects.toThrow()
  })

  it('降级模式下另一实例(模拟重启)读不到内容', async () => {
    const vault = await optIn({}, false)
    await vault.rememberPassword('i1', 'hunter2')
    const restarted = createVault({ filePath, crypto: fakeCrypto(false) })
    expect(restarted.getPassword('i1')).toBeNull()
  })

  it('解密失败只丢该条目,不影响其它实例', async () => {
    const vault = await optIn()
    await vault.setPolicy('i2', BOTH)
    await vault.rememberPassword('i1', 'p1')
    await vault.rememberPassword('i2', 'p2')

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

    // 读路径不写盘:坏条目只是从内存里丢掉,文件由下一次显式写入收敛
    const stillTampered = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: Record<string, { password: string }>
    }
    expect(stillTampered.items['i1']?.password).toBe('garbage')
    await reopened.forgetPassword('i2')
    const converged = JSON.parse(await readFile(filePath, 'utf8')) as { items: Record<string, unknown> }
    expect(converged.items).toEqual({})
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

  it('空密码/空会话被拒绝(即便已勾选)', async () => {
    const vault = await optIn()
    await expect(vault.rememberPassword('i1', '')).rejects.toThrow()
    await expect(vault.rememberSession('i1', { ...SESSION, value: '' })).rejects.toThrow()
    expect(vault.rememberedIds()).toEqual([])
  })

  it('forgetInstance 清某实例条目+策略;clearAll 一键清空', async () => {
    const vault = await optIn()
    await vault.rememberPassword('i1', 'p1')
    await vault.rememberSession('i1', SESSION)
    await vault.setPolicy('i2', BOTH)
    await vault.rememberPassword('i2', 'p2')

    await vault.forgetInstance('i1')
    expect(vault.getPassword('i1')).toBeNull()
    expect(vault.getSession('i1')).toBeNull()
    // 字面量断言(而非与 DEFAULT 自比):默认值本身是安全相关常量,必须被钉住
    expect(vault.getPolicy('i1')).toEqual({ rememberPassword: false, rememberSession: false })
    expect(DEFAULT_VAULT_POLICY).toEqual({ rememberPassword: false, rememberSession: false })
    expect(vault.getPassword('i2')).toBe('p2')
    expect(vault.getPolicy('i2')).toEqual(BOTH)

    await vault.clearAll()
    expect(vault.rememberedIds()).toEqual([])
    expect(vault.getPolicy('i2')).toEqual(DEFAULT_VAULT_POLICY)
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: unknown
      policy: unknown
    }
    expect(parsed.items).toEqual({})
    expect(parsed.policy).toEqual({})
    // 一键清除后,没重新勾选就不能再落盘
    await expect(vault.rememberPassword('i2', 'p2')).rejects.toThrow()
  })

  it('会话载荷不是合法 JSON 时:丢弃且**不把解密后的内容**交给 onError', async () => {
    // 默认 onError 会 console.error(error),而 JSON.parse 的报错消息内嵌输入 ——
    // 即解密后的会话 Cookie。凭据纪律:日志只记事件,不记内容。
    const encryption = fakeCrypto()
    const vault = createVault({ filePath, crypto: encryption })
    await vault.setPolicy('i1', BOTH)
    // 直接写一个「能解密但不是 JSON」的会话载荷
    await vault.rememberSession('i1', { ...SESSION, value: 'x' })
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      items: Record<string, { session: string }>
    }
    parsed.items['i1']!.session = encryption.encrypt('sess-secret-not-json')
    await writeFile(filePath, JSON.stringify(parsed))

    const errors: unknown[] = []
    const reopened = createVault({
      filePath,
      crypto: encryption,
      onError: (error) => errors.push(error)
    })
    expect(reopened.getSession('i1')).toBeNull()
    expect(errors).toHaveLength(1)
    // 关键断言:错误对象里不得出现解密后的内容
    const serialized = String(errors[0]) + JSON.stringify(errors[0], Object.getOwnPropertyNames(errors[0]))
    expect(serialized).not.toContain('sess-secret-not-json')
  })

  it('hasPassword/hasSession 不触发解密(损坏条目的存在性判断不受影响)', async () => {
    const vault = await optIn()
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
