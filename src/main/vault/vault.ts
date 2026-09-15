/**
 * 凭据保险库（T10,设计文档 §7.2）—— 不 import electron:加密后端由调用方注入
 * (生产为 electron `safeStorage`,测试为可控假实现)。
 *
 * 策略(§7.2「会话态优先、密钥态可选」):
 *
 *  | 存储项 | 默认 | 可选 |
 *  |---|---|---|
 *  | 网关密码 | **不存**(每次输入/会话期内存) | 用户勾选「记住密码」 |
 *  | 会话 Cookie `dsh_auth` | 内存;重启后重登失败再弹登录 | 勾选「记住登录态」 |
 *  | TOTP 密钥 | **永不存储**(密钥在用户认证器里) | — |
 *
 * 硬性约定:
 * 1. **只有显式调用才会落盘**;没有 `remember*` 就没有条目;
 * 2. 落盘内容一律经 `crypto.encrypt`(safeStorage → OS 钥匙串密钥加密),
 *    文件权限 0600,原子写(tmp + rename);
 * 3. `safeStorage` 不可用(如 Linux 无 keyring)时**降级为纯内存模式**:
 *    不写文件、`status().degraded === true`,由调用方在 UI 告警 + 审计
 *    `vault-unavailable`;**绝不退化成明文落盘**;
 * 4. 解密失败(钥匙串变更/文件被改)视为该条目不可用:丢弃该字段并上报,
 *    不影响其它字段与其它实例;
 * 5. 凭据永不进日志/审计 —— 本模块不 import 任何日志设施,只经 `onError`
 *    上报错误对象(调用方负责不把密文/明文写进日志)。
 *
 * 关于**勾选策略**(§7.2 的「记住密码 / 记住登录态」):
 * 它与「记住了什么」共享同一生命周期 —— 一键清除必须同时停止「继续记住」,
 * 否则清空后下一次登录又会把凭据写回来。因此策略与条目放在同一文件(顶层
 * `policy` 段,明文、非敏感),`clearAll`/`forgetInstance` 一并清掉。
 * 降级模式不落盘:此时复选框本就无意义(钥匙串不可用,什么也记不住)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 加密后端(生产:`electron.safeStorage`) */
export interface VaultCrypto {
  /** 系统加密是否可用;false 即降级为内存模式 */
  isAvailable(): boolean
  /** 明文 → 可落盘字符串(通常 base64) */
  encrypt(plain: string): string
  /** 落盘字符串 → 明文;失败应抛 */
  decrypt(payload: string): string
}

/** 持久化的会话 Cookie(与 AuthClient 内存态同构) */
export interface StoredSession {
  name: string
  value: string
  expiresAt: number | null
}

export interface VaultOptions {
  /** 落盘路径(通常 `<userData>/vault/credentials.json`) */
  filePath: string
  crypto: VaultCrypto
  /** 失败上报(默认 console.error);只上报 Error,**不要**把明文/密文带进来 */
  onError?: (error: unknown) => void
}

export interface VaultStatus {
  /** 系统加密可用 */
  available: boolean
  /** 是否处于降级(纯内存)模式 */
  degraded: boolean
  /** 已记住条目的实例数 */
  instanceCount: number
}

export interface Vault {
  status(): VaultStatus
  hasPassword(instanceId: string): boolean
  rememberPassword(instanceId: string, password: string): Promise<void>
  getPassword(instanceId: string): string | null
  forgetPassword(instanceId: string): Promise<void>

  hasSession(instanceId: string): boolean
  rememberSession(instanceId: string, session: StoredSession): Promise<void>
  getSession(instanceId: string): StoredSession | null
  forgetSession(instanceId: string): Promise<void>

  /** 读取勾选策略(未设置即「都不记住」) */
  getPolicy(instanceId: string): VaultPolicy
  /** 写入勾选策略 */
  setPolicy(instanceId: string, policy: VaultPolicy): Promise<void>

  /** 清掉某实例的全部条目(删除实例时调用) */
  forgetInstance(instanceId: string): Promise<void>
  /** 一键清空(设计 §7.2「可一键清除」) */
  clearAll(): Promise<void>
  /** 已记住条目的实例 id(自检/测试) */
  rememberedIds(): string[]
  /**
   * **已设置策略**的实例 id。
   *
   * 与 `rememberedIds` 刻意分开:用户可能先勾选「记住密码」、下一次登录才真正写入凭据,
   * 此期间策略已设但条目为空。UI 若按「有条目」下发策略,复选框会显示未勾选,
   * 用户再动另一个开关就会把刚设的策略覆盖掉(复审 F1/F2)。
   */
  policyIds(): string[]
}

/** 用户显式勾选的记住策略(§7.2;非敏感,明文存) */
export interface VaultPolicy {
  /** 记住网关密码(勾选后才写入钥匙串) */
  rememberPassword: boolean
  /** 记住登录态(会话 Cookie),重启静默复用 */
  rememberSession: boolean
}

export const DEFAULT_VAULT_POLICY: VaultPolicy = {
  rememberPassword: false,
  rememberSession: false
}

/** 落盘格式(版本化,便于后续迁移) */
interface VaultItem {
  password?: string
  session?: string
}
interface VaultFile {
  version: 1
  items: Record<string, VaultItem>
  policy?: Record<string, VaultPolicy>
}

function isVaultFile(value: unknown): value is VaultFile {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<VaultFile>
  return candidate.version === 1 && typeof candidate.items === 'object' && candidate.items !== null
}

function normalizePolicy(value: unknown): VaultPolicy {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_VAULT_POLICY }
  const candidate = value as Partial<VaultPolicy>
  return {
    rememberPassword: candidate.rememberPassword === true,
    rememberSession: candidate.rememberSession === true
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<StoredSession>
  return typeof candidate.name === 'string' && typeof candidate.value === 'string'
}

export function createVault(options: VaultOptions): Vault {
  const onError =
    options.onError ?? ((error: unknown) => console.error('[vault] 操作失败：', error))
  const crypto = options.crypto
  // 可用性在创建时确定(与 electron safeStorage 一致:启动后不变)
  const available = crypto.isAvailable()

  /**
   * 条目表。可用时存放**密文**(经 crypto.encrypt);降级模式下存放**明文**,
   * 但降级模式永不落盘(见 persist),因此明文不会离开进程内存。
   */
  const items = new Map<string, VaultItem>()
  const policy = new Map<string, VaultPolicy>()
  let loaded = false

  function load(): void {
    if (loaded) return
    loaded = true
    if (!available) return
    if (!existsSync(options.filePath)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(options.filePath, 'utf8'))
      if (!isVaultFile(parsed)) {
        onError(new Error('vault 文件格式不符,已忽略'))
        return
      }
      for (const [id, raw] of Object.entries(parsed.items)) {
        if (typeof raw !== 'object' || raw === null) continue
        const entry: VaultItem = {}
        if (typeof raw.password === 'string') entry.password = raw.password
        if (typeof raw.session === 'string') entry.session = raw.session
        if (entry.password !== undefined || entry.session !== undefined) items.set(id, entry)
      }
      for (const [id, raw] of Object.entries(parsed.policy ?? {})) {
        policy.set(id, normalizePolicy(raw))
      }
    } catch (error) {
      onError(error)
    }
  }

  /** 降级模式只留内存:退化成明文落盘是不可接受的 */
  async function persist(): Promise<void> {
    if (!available) return
    const payload: VaultFile = { version: 1, items: {}, policy: {} }
    for (const [id, entry] of items) {
      const next: VaultItem = {}
      if (entry.password !== undefined) next.password = entry.password
      if (entry.session !== undefined) next.session = entry.session
      if (next.password !== undefined || next.session !== undefined) payload.items[id] = next
    }
    for (const [id, value] of policy) {
      if (value.rememberPassword || value.rememberSession) payload.policy![id] = value
    }
    const path = options.filePath
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
    await rename(tmp, path)
  }

  /**
   * 显式勾选才允许落盘(§7.2「默认不存、显式勾选」)。
   * 在模块内强制而非依赖调用方约定 —— 少一处调用方疏漏就少一条凭据落盘路径。
   */
  function requireOptIn(instanceId: string, field: keyof VaultPolicy): void {
    if (!(policy.get(instanceId)?.[field] ?? false)) {
      throw new Error(`未勾选「${field}」,拒绝写入 vault`)
    }
  }

  function entryFor(instanceId: string): VaultItem {
    const existing = items.get(instanceId)
    if (existing) return existing
    const created: VaultItem = {}
    items.set(instanceId, created)
    return created
  }

  function dropIfEmpty(instanceId: string): void {
    const entry = items.get(instanceId)
    if (entry && entry.password === undefined && entry.session === undefined) {
      items.delete(instanceId)
    }
  }

  /**
   * 解密单个字段;失败即丢弃该字段(钥匙串变更/文件被篡改)。
   *
   * **读路径不写盘**:丢弃只发生在内存里,由下一次显式写入(persist 的调用方)落地。
   * 旧实现在这里发起了 fire-and-forget 的 `persist()`,让一次「读」产生磁盘写 ——
   * 那是并发不可控的副作用(单测在并行负载下会偶发失败),而且读操作本就不该有写副作用。
   */
  function readField(instanceId: string, payload: string): string | null {
    if (!available) return payload // 降级模式条目本就是明文
    try {
      return crypto.decrypt(payload)
    } catch (error) {
      onError(error)
      const entry = items.get(instanceId)
      if (entry?.password === payload) delete entry.password
      if (entry?.session === payload) delete entry.session
      dropIfEmpty(instanceId)
      return null
    }
  }

  /** 写入字段:降级模式下存明文(内存),可用时存密文 */
  function encode(value: string): string {
    return available ? crypto.encrypt(value) : value
  }

  return {
    status() {
      load()
      return { available, degraded: !available, instanceCount: items.size }
    },

    hasPassword(instanceId) {
      load()
      return items.get(instanceId)?.password !== undefined
    },

    async rememberPassword(instanceId, password) {
      if (password === '') throw new Error('空密码不写入 vault')
      load()
      requireOptIn(instanceId, 'rememberPassword')
      entryFor(instanceId).password = encode(password)
      await persist()
    },

    getPassword(instanceId) {
      load()
      const payload = items.get(instanceId)?.password
      return payload === undefined ? null : readField(instanceId, payload)
    },

    async forgetPassword(instanceId) {
      load()
      const entry = items.get(instanceId)
      if (!entry) return
      delete entry.password
      dropIfEmpty(instanceId)
      await persist()
    },

    hasSession(instanceId) {
      load()
      return items.get(instanceId)?.session !== undefined
    },

    async rememberSession(instanceId, session) {
      if (session.value === '') throw new Error('空会话不写入 vault')
      load()
      requireOptIn(instanceId, 'rememberSession')
      entryFor(instanceId).session = encode(JSON.stringify(session))
      await persist()
    },

    getSession(instanceId) {
      load()
      const payload = items.get(instanceId)?.session
      if (payload === undefined) return null
      const plain = readField(instanceId, payload)
      if (plain === null) return null
      try {
        const parsed: unknown = JSON.parse(plain)
        if (!isStoredSession(parsed)) return null
        return {
          name: parsed.name,
          value: parsed.value,
          expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null
        }
      } catch (error) {
        onError(error)
        return null
      }
    },

    async forgetSession(instanceId) {
      load()
      const entry = items.get(instanceId)
      if (!entry) return
      delete entry.session
      dropIfEmpty(instanceId)
      await persist()
    },

    async forgetInstance(instanceId) {
      load()
      items.delete(instanceId)
      // 实例已删除:勾选策略一并清掉(否则重建同名实例会继承旧策略)
      policy.delete(instanceId)
      await persist()
    },

    async clearAll() {
      load()
      items.clear()
      policy.clear()
      await persist()
    },

    getPolicy(instanceId) {
      load()
      return policy.get(instanceId) ?? { ...DEFAULT_VAULT_POLICY }
    },

    async setPolicy(instanceId, next) {
      load()
      const normalized = normalizePolicy(next)
      // **取消勾选必须真的忘掉**,而不是只停止「继续记住」
      const entry = items.get(instanceId)
      if (!normalized.rememberPassword && entry?.password !== undefined) delete entry.password
      if (!normalized.rememberSession && entry?.session !== undefined) delete entry.session
      dropIfEmpty(instanceId)
      if (normalized.rememberPassword || normalized.rememberSession) {
        policy.set(instanceId, normalized)
      } else {
        policy.delete(instanceId)
      }
      await persist()
    },

    rememberedIds() {
      load()
      return [...items.keys()]
    },

    policyIds() {
      load()
      return [...policy.keys()]
    }
  }
}
