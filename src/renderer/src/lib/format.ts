/**
 * 展示层工具：状态、类型映射和格式化。
 * 认证相关状态（auth/interrupted/locked）也在此映射。
 */
import type { InstanceRecord, InstanceRuntimeStatus, Transport } from '@shared/contracts'
import type { MessageKey } from '@shared/i18n/messages'
import type { Translator } from '@shared/i18n'
import type { IconName } from './icons'

export type DisplayStatus =
  | 'idle'
  | 'connecting'
  | 'auth'
  | 'connected'
  | 'interrupted'
  | 'error'
  | 'locked'
  | 'installing'

export interface DisplayStatusInfo {
  chipClass: string
  dotClass: string
  icon: IconName
  /** 文案 key(由调用方经 store 的 t() 渲染) */
  labelKey: MessageKey
}

export const STATUS_INFO: Record<DisplayStatus, DisplayStatusInfo> = {
  idle: { labelKey: 'state.idle', chipClass: 'c-idle', dotClass: '', icon: 'wifi' },
  connecting: {
    labelKey: 'state.connecting',
    chipClass: 'c-info',
    dotClass: 's-connecting',
    icon: 'refresh'
  },
  auth: { labelKey: 'state.auth', chipClass: 'c-warn', dotClass: 's-auth', icon: 'key' },
  connected: {
    labelKey: 'state.connected',
    chipClass: 'c-ok',
    dotClass: 's-connected',
    icon: 'check'
  },
  interrupted: {
    labelKey: 'state.interrupted',
    chipClass: 'c-warn',
    dotClass: 's-interrupted',
    icon: 'wifi'
  },
  error: { labelKey: 'state.error', chipClass: 'c-err', dotClass: 's-error', icon: 'alert' },
  locked: { labelKey: 'state.locked', chipClass: 'c-err', dotClass: 's-locked', icon: 'lock' },
  installing: { labelKey: 'state.installing', chipClass: 'c-info', dotClass: 's-connecting', icon: 'refresh' }
}

/** 将运行时状态映射为展示状态。 */
export function toDisplayStatus(status?: InstanceRuntimeStatus, workspaceConnected = true): DisplayStatus {
  if (status === 'running' && !workspaceConnected) return 'idle'
  switch (status) {
    case 'starting':
      return 'connecting'
    case 'installing':
      return 'installing'
    case 'running':
      return 'connected'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}

/**
 * 运行时状态 → 展示信息（圆点 / 胶囊 / 文案由**同一次映射**给出）。
 *
 * 列表和侧边栏共用此映射，确保圆点、胶囊和文案反映同一状态。
 */
export function toStatusInfo(status?: InstanceRuntimeStatus, workspaceConnected = true): DisplayStatusInfo {
  return STATUS_INFO[toDisplayStatus(status, workspaceConnected)]
}

/**
 * 展示层类型标签只保存文案 key，文案由调用方翻译。
 */
export const TYPE_INFO: Record<Transport, { labelKey: MessageKey; icon: IconName }> = {
  local: { labelKey: 'transport.local', icon: 'local' },
  ssh: { labelKey: 'transport.ssh', icon: 'ssh' },
  http: { labelKey: 'transport.http', icon: 'remote' }
}

export function addressOf(record: InstanceRecord): string {
  switch (record.transport) {
    case 'local':
      return `127.0.0.1:${record.port ?? '—'}`
    case 'ssh':
      return `${record.host}:${record.remotePort}`
    case 'http':
      return record.endpointUrl
  }
}

/** 标题栏只展示可扫描的 endpoint 主机/端口，避免路径和认证探测详情占满空间。 */
export function compactWorkspaceAddress(address: string): string {
  try {
    const url = new URL(address)
    return url.host || address
  } catch {
    return address.length > 64 ? `${address.slice(0, 61)}…` : address
  }
}

/**
 * 运行时长(毫秒)→ 人类可读。
 * 文案通过翻译器生成，避免在此硬编码语言文本。
 */
export function fmtDuration(ms: number, t: Translator): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return t('duration.seconds', { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('duration.minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('duration.hours', { h: hours, m: minutes % 60 })
  return t('duration.days', { d: Math.floor(hours / 24), h: hours % 24 })
}