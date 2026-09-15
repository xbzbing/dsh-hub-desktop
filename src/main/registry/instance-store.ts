/**
 * 实例注册表存储（T2）—— 不 import electron（全局规则 5）。
 *
 * 设计依据：`docs/desktop-implementation-plan.md` §6.1：
 * - 数据文件 `<registryDir>/instances.json`；写入 = 临时文件 + rename（原子）；
 * - 每次改动前滚动 `.bak-<ts>`（保留 bakRetention 份，默认 20）；
 * - schema 校验（zod，见 contracts.ts）+ 迁移钩子 + 损坏自愈（隔离到 .corrupt-<ts> 后重生）。
 *
 * 所有变更经内部串行队列执行，避免并发交错落盘。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  CreateInstanceInputSchema,
  formatZodIssues,
  HttpInstanceSchema,
  InstanceRecordSchema,
  LocalInstanceSchema,
  PatchInstanceSchema,
  REGISTRY_SCHEMA_VERSION,
  RegistryFileSchema,
  SshInstanceSchema,
  splitSshHostPort,
  type CreateInstanceInput,
  type CreateInstanceParams,
  type InstanceRecord,
  type PatchInstanceInput,
  type PatchInstanceParams,
  type RegistryFile,
  type RegistryMigration,
  type Transport
} from '@shared/contracts'
import { parseEndpointUrl } from '@shared/endpoint'

const FILE_NAME = 'instances.json'
const BAK_PREFIX = `${FILE_NAME}.bak-`
const CORRUPT_PREFIX = `${FILE_NAME}.corrupt-`

export type StoreErrorCode = 'invalid-input' | 'not-found' | 'invalid-state' | 'io-error'

export class InstanceStoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string) {
    super(message)
    this.name = 'InstanceStoreError'
    this.code = code
  }
}

export interface InstanceStoreOptions {
  /** 注册表目录（main 进程传 `<userData>/registry`） */
  dir: string
  /** 迁移表 from-version → 升级一版；默认内置（当前为空）。测试可注入伪造历史 */
  migrations?: Record<number, RegistryMigration>
  /** 滚动备份保留份数 */
  bakRetention?: number
  /** 损坏文件隔离保留份数 */
  corruptRetention?: number
}

export interface InstanceStoreStats {
  fileExists: boolean
  /** 最近一次损坏恢复的时间（epoch ms）；从未恢复为 null */
  lastRecoveryAt: number | null
  bakCount: number
  corruptCount: number
}

export interface InstanceStore {
  list(): Promise<InstanceRecord[]>
  get(id: string): Promise<InstanceRecord | null>
  create(input: CreateInstanceInput): Promise<InstanceRecord>
  update(id: string, patch: PatchInstanceInput): Promise<InstanceRecord>
  remove(id: string): Promise<boolean>
  stats(): Promise<InstanceStoreStats>
}

export function createInstanceStore(options: InstanceStoreOptions): InstanceStore {
  const dir = options.dir
  const filePath = join(dir, FILE_NAME)
  const migrations = options.migrations ?? {}
  const bakRetention = options.bakRetention ?? 20
  const corruptRetention = options.corruptRetention ?? 5

  let instances: InstanceRecord[] | null = null
  let lastRecoveryAt: number | null = null
  let dirty = false
  let chain: Promise<unknown> = Promise.resolve()

  /** 串行队列：所有读写共享同一互斥链 */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task)
    chain = next.catch(() => undefined)
    return next
  }

  async function ensureLoaded(): Promise<void> {
    if (instances) return
    await mkdir(dir, { recursive: true })
    await removeStaleTmpFiles()

    let raw: string | null = null
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        instances = [] // 首次使用：空注册表（必须赋值，否则后续 push 会静默丢失）
        return
      }
      throw toStoreError(error)
    }

    const loaded = await loadRegistryFile(raw)
    instances = loaded.instances
    lastRecoveryAt = loaded.recoveredAt
    // 恢复 / 迁移后需要立即重写归一化文件（自愈落盘：文件回到 schemaVersion=当前 的合法形态）
    dirty = loaded.recoveredAt !== null || loaded.migrated
    if (dirty) await persist(instances ?? [])
  }

  interface LoadResult {
    instances: InstanceRecord[]
    recoveredAt: number | null
    migrated: boolean
  }

  async function loadRegistryFile(raw: string): Promise<LoadResult> {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      await quarantineCorruptFile('JSON 解析失败')
      return { instances: [], recoveredAt: Date.now(), migrated: false }
    }

    // —— 版本检查与迁移 ——
    const rawVersion = (data as { schemaVersion?: unknown } | null)?.schemaVersion
    const from = typeof rawVersion === 'number' && Number.isInteger(rawVersion) ? rawVersion : 0
    if (from > REGISTRY_SCHEMA_VERSION) {
      // 文件来自更新版本的应用：拒绝降级读取
      await quarantineCorruptFile(`schemaVersion=${from} 高于当前 ${REGISTRY_SCHEMA_VERSION}，拒绝降级`)
      return { instances: [], recoveredAt: Date.now(), migrated: false }
    }
    for (let v = from; v < REGISTRY_SCHEMA_VERSION; v++) {
      const migrate = migrations[v]
      if (!migrate) {
        await quarantineCorruptFile(`缺少 schemaVersion ${v} → ${v + 1} 的迁移器`)
        return { instances: [], recoveredAt: Date.now(), migrated: false }
      }
      data = migrate(data)
    }

    // —— 最终校验 ——
    let parsed: RegistryFile
    try {
      parsed = RegistryFileSchema.parse(data)
    } catch (error) {
      const reason =
        error instanceof z.ZodError ? formatZodIssues(error, 200) : String(error)
      await quarantineCorruptFile(`schema 校验失败：${reason}`)
      return { instances: [], recoveredAt: Date.now(), migrated: false }
    }
    return { instances: parsed.instances, recoveredAt: null, migrated: from !== REGISTRY_SCHEMA_VERSION }
  }

  /** 把损坏文件移出主路径，并修剪隔离副本数量 */
  async function quarantineCorruptFile(reason: string): Promise<void> {
    const target = join(dir, `${CORRUPT_PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}`)
    try {
      await rename(filePath, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw toStoreError(error)
    }
    await pruneByPrefix(CORRUPT_PREFIX, corruptRetention)
    console.warn(`[registry] 注册表损坏已隔离：${reason} → ${target}`)
  }

  /**
   * 磁盘先提交：备份旧文件 → 原子写新文件，全部成功后**才**替换内存缓存。
   * 写盘失败时内存不被污染（评审 R3：写失败不再产生幻影记录，错误契约可信）。
   */
  async function persist(next: InstanceRecord[]): Promise<void> {
    const data: RegistryFile = { schemaVersion: REGISTRY_SCHEMA_VERSION, instances: next }
    await rollBackup()
    const tmpPath = join(dir, `${FILE_NAME}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
    try {
      await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8')
      await rename(tmpPath, filePath)
    } catch (error) {
      try {
        await rm(tmpPath, { force: true })
      } catch {
        /* 尽力清理 */
      }
      throw toStoreError(error)
    }
    instances = next
    dirty = false
  }

  async function rollBackup(): Promise<void> {
    let current: Buffer
    try {
      current = await readFile(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // 首次写盘无旧文件
      throw toStoreError(error)
    }
    try {
      await writeFile(
        join(dir, `${BAK_PREFIX}${Date.now()}-${randomUUID().slice(0, 4)}`),
        current
      )
    } catch (error) {
      throw toStoreError(error)
    }
    await pruneByPrefix(BAK_PREFIX, bakRetention)
  }

  async function pruneByPrefix(prefix: string, retention: number): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    const matches = names.filter((name) => name.startsWith(prefix)).sort().reverse()
    for (const name of matches.slice(retention)) {
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  }

  /** 崩溃可能残留 `*.tmp-*`，加载时清掉 */
  async function removeStaleTmpFiles(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith(`${FILE_NAME}.tmp-`)) {
        await rm(join(dir, name), { force: true }).catch(() => undefined)
      }
    }
  }

  // —— 归一化（写盘前的规范化） ——

  function normalizeCreate(input: CreateInstanceParams): CreateInstanceParams {
    if (input.transport === 'ssh') {
      const split = splitSshHostPort(input.host, input.port ?? 22)
      if (split.host === input.host && !split.portEmbedded) return input
      // host:port 组合形式 → 拆分出的端口优先（文档化约定）；
      // 纯方括号剥离 → 只归一化主机形态，端口交给显式 port / 记录默认值
      return split.portEmbedded
        ? { ...input, host: split.host, port: split.port }
        : { ...input, host: split.host }
    }
    if (input.transport === 'http') {
      // 存归一化 baseUrl（去尾斜杠等），判重语义与 isSameEndpoint 一致
      return { ...input, endpointUrl: parseEndpointUrl(input.endpointUrl).baseUrl }
    }
    return input
  }

  function normalizePatch(patch: PatchInstanceParams): PatchInstanceParams {
    // 与 create 语义一致：仅当 host 内真正带 `:port` 时才采用其端口；
    // 方括号剥离只改主机形态，绝不注入默认端口（否则会静默改掉记录里的端口）
    if (patch.host !== undefined) {
      const split = splitSshHostPort(patch.host, patch.port ?? 22)
      if (split.host !== patch.host) {
        return split.portEmbedded
          ? { ...patch, host: split.host, port: split.port }
          : { ...patch, host: split.host }
      }
    }
    if (patch.endpointUrl !== undefined) {
      const parsed = parseEndpointUrl(patch.endpointUrl)
      if (parsed.baseUrl !== patch.endpointUrl.trim()) {
        return { ...patch, endpointUrl: parsed.baseUrl }
      }
    }
    return patch
  }

  function stamp(record: unknown): InstanceRecord {
    return InstanceRecordSchema.parse(record) // 最终完整性校验（含默认值填充），运行期兜底
  }

  /** zod 校验失败统一转成契约内的 invalid-input 错误码（store 只抛 InstanceStoreError） */
  function parseOrThrow<T>(parse: () => T): T {
    try {
      return parse()
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new InstanceStoreError('invalid-input', formatZodIssues(error))
      }
      throw error
    }
  }

  function variantSchema(transport: Transport): z.ZodObject<z.ZodRawShape> {
    switch (transport) {
      case 'local':
        return LocalInstanceSchema
      case 'ssh':
        return SshInstanceSchema
      case 'http':
        return HttpInstanceSchema
    }
  }

  /**
   * 把补丁显式合入实例：undefined 表示「不改」、null 表示「清空」。
   * 同时拒绝与实例变体无关的字段（local 实例不许带 ssh/http 专属字段），
   * 避免非 strict 记录 schema 静默剥离跨变体字段。
   */
  function applyPatch(current: InstanceRecord, patch: PatchInstanceParams): Record<string, unknown> {
    const allowed = new Set(Object.keys(variantSchema(current.transport).shape))
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) {
        throw new InstanceStoreError('invalid-input', `字段 ${key} 不适用于 ${current.transport} 实例`)
      }
    }
    const merged: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) merged[key] = value
    }
    return merged
  }

  // —— 对外 API ——

  return {
    list: () =>
      enqueue(async () => {
        await ensureLoaded()
        // 返回拷贝，调用方（未来主进程消费者）无法污染缓存
        return (instances ?? []).map((record) => structuredClone(record))
      }),

    get: (id) =>
      enqueue(async () => {
        await ensureLoaded()
        const record = (instances ?? []).find((item) => item.id === id)
        // 返回拷贝,避免调用方污染缓存(评审 Nit)
        return record ? structuredClone(record) : null
      }),

    create: (input) =>
      enqueue(async () => {
        await ensureLoaded()
        const parsed = parseOrThrow(() => CreateInstanceInputSchema.parse(input))
        const now = new Date().toISOString()
        const record = parseOrThrow(() =>
          stamp({ ...normalizeCreate(parsed), id: randomUUID(), createdAt: now, updatedAt: now })
        )
        // 磁盘先提交,成功后才进入内存(评审 R3)
        await persist([...(instances ?? []), record])
        return structuredClone(record)
      }),

    update: (id, patch) =>
      enqueue(async () => {
        await ensureLoaded()
        const parsedPatch = parseOrThrow(() => PatchInstanceSchema.parse(patch))
        const current = (instances ?? []).find((record) => record.id === id)
        if (!current) throw new InstanceStoreError('not-found', `实例不存在：${id}`)
        const record = parseOrThrow(() =>
          stamp({
            ...applyPatch(current, normalizePatch(parsedPatch)),
            updatedAt: new Date().toISOString()
          })
        )
        await persist((instances ?? []).map((item) => (item.id === id ? record : item)))
        return structuredClone(record)
      }),

    remove: (id) =>
      enqueue(async () => {
        await ensureLoaded()
        const current = instances ?? []
        if (!current.some((record) => record.id === id)) return false
        await persist(current.filter((record) => record.id !== id))
        return true
      }),

    stats: () =>
      enqueue(async () => {
        await ensureLoaded()
        let names: string[]
        try {
          names = await readdir(dir)
        } catch {
          names = []
        }
        return {
          fileExists: names.includes(FILE_NAME),
          lastRecoveryAt,
          bakCount: names.filter((name) => name.startsWith(BAK_PREFIX)).length,
          corruptCount: names.filter((name) => name.startsWith(CORRUPT_PREFIX)).length
        }
      })
  }
}

function toStoreError(error: unknown): InstanceStoreError {
  const message = error instanceof Error ? error.message : String(error)
  return new InstanceStoreError('io-error', `注册表 IO 失败：${message}`)
}