/**
 * 展示层工具：状态/类型映射与格式化（对应原型 STATUS / TYPE 常量表）。
 * 认证相关状态（auth/interrupted/locked）随 T7 认证层接入,这里先按 T3 规则映射。
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
  locked: { labelKey: 'state.locked', chipClass: 'c-err', dotClass: 's-locked', icon: 'lock' }
}

/** T3 映射:运行时四态 → 设计稿七态(认证三态由 T7 补) */
export function toDisplayStatus(status?: InstanceRuntimeStatus): DisplayStatus {
  switch (status) {
    case 'starting':
      return 'connecting'
    case 'running':
      return 'connected'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}

/**
 * 展示层类型标签**只放文案 key**,不放文案本身 ——
 * 否则 lib 层会残留硬编码文案,双语就必然有遗漏(由 i18n-coverage.test.ts 钉住)。
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

/**
 * 运行时长(毫秒)→ 人类可读。
 * 文案经翻译器而非在此拼中文:lib 层残留硬编码文案必然导致双语遗漏
 * (由 i18n-coverage.test.ts 钉住)。
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