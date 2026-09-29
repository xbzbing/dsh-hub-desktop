/**
 * 插件检查状态的持久化（按实例一份 JSON，落在 `<dataRoot>/plugin-state/<id>.json`）。
 *
 * 检查结果要跨「离开详情页」与「应用重启」保留：用户不升级时，可升级标记一直显示，
 * 直到下次检查或升级才改写。状态只存检查得到的候选信息（latest/compatible/…），
 * 是否「有更新」由渲染层拿当前已装版本现算，版本变了标记自然消失。
 *
 * 写入用「临时文件 + rename」原子替换，避免中断留下半截 JSON；读取失败一律当作无状态，
 * 绝不因状态文件损坏影响插件列表。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PluginCheckRecord } from '@shared/contracts'

export type { PluginCheckRecord }

/** 因与运行时 dsh 不兼容而被自动禁用的插件。 */
export interface AutoDisabledPlugin {
  name: string
  /** 被禁用时的插件版本。 */
  version: string
  /** 判定不兼容时的 dsh 版本。 */
  dshVersion: string
}

export interface PluginCheckState {
  /** 上次完成检查的时刻（ISO）；null = 尚未检查过。 */
  lastCheckedAt: string | null
  /** 插件名 → 检查结果摘要（仅记录检查过的插件）。 */
  updates: Record<string, PluginCheckRecord>
  /** 插件名 → 被禁用时在 `dsh.profile.bundles` 里的索引，重新启用时按它插回原位。 */
  bundleIndex: Record<string, number>
  /** 上次「运行时版本变更后核对插件兼容性」时记录的 dsh 版本；null = 尚未核对过。 */
  runtimeVersion: string | null
  /** 最近一次核对中因不兼容被自动禁用的插件（供界面提示）。 */
  autoDisabled: AutoDisabledPlugin[]
}

export interface PluginStateStore {
  read(instanceId: string): Promise<PluginCheckState>
  /** 覆盖写入整个状态（调用方给出完整快照）。 */
  write(instanceId: string, state: PluginCheckState): Promise<void>
}

const EMPTY_STATE: PluginCheckState = {
  lastCheckedAt: null,
  updates: {},
  bundleIndex: {},
  runtimeVersion: null,
  autoDisabled: []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 宽松解析：字段类型不对就丢弃该字段，不因单条脏数据丢掉整份状态。 */
function parseState(raw: unknown): PluginCheckState {
  if (!isRecord(raw)) return { ...EMPTY_STATE, updates: {}, bundleIndex: {}, autoDisabled: [] }
  const lastCheckedAt = typeof raw.lastCheckedAt === 'string' ? raw.lastCheckedAt : null
  const updates: Record<string, PluginCheckRecord> = {}
  const source = isRecord(raw.updates) ? raw.updates : {}
  for (const [name, value] of Object.entries(source)) {
    if (!isRecord(value)) continue
    if (typeof value.latest !== 'string' || value.latest === '') continue
    updates[name] = {
      latest: value.latest,
      compatible: value.compatible !== false,
      dshPeer: typeof value.dshPeer === 'string' ? value.dshPeer : null,
      dshVersion: typeof value.dshVersion === 'string' ? value.dshVersion : null,
      modifiedAt: typeof value.modifiedAt === 'string' ? value.modifiedAt : null
    }
  }
  const bundleIndex: Record<string, number> = {}
  const indexSource = isRecord(raw.bundleIndex) ? raw.bundleIndex : {}
  for (const [name, value] of Object.entries(indexSource)) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) bundleIndex[name] = value
  }
  const runtimeVersion = typeof raw.runtimeVersion === 'string' ? raw.runtimeVersion : null
  const autoDisabled: AutoDisabledPlugin[] = []
  if (Array.isArray(raw.autoDisabled)) {
    for (const item of raw.autoDisabled) {
      if (!isRecord(item)) continue
      if (typeof item.name !== 'string' || typeof item.version !== 'string') continue
      autoDisabled.push({
        name: item.name,
        version: item.version,
        dshVersion: typeof item.dshVersion === 'string' ? item.dshVersion : ''
      })
    }
  }
  return { lastCheckedAt, updates, bundleIndex, runtimeVersion, autoDisabled }
}

export function createPluginStateStore(dataRoot: string): PluginStateStore {
  const dir = join(dataRoot, 'plugin-state')
  const fileFor = (instanceId: string): string => join(dir, `${instanceId}.json`)

  return {
    async read(instanceId: string): Promise<PluginCheckState> {
      try {
        return parseState(JSON.parse(await readFile(fileFor(instanceId), 'utf8')))
      } catch {
        return { ...EMPTY_STATE, updates: {}, bundleIndex: {}, autoDisabled: [] }
      }
    },

    async write(instanceId: string, state: PluginCheckState): Promise<void> {
      await mkdir(dir, { recursive: true })
      const target = fileFor(instanceId)
      const tmp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, target)
    }
  }
}
