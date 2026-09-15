/**
 * 展示层工具：状态/类型映射与格式化（对应原型 STATUS / TYPE 常量表）。
 * 认证相关状态（auth/interrupted/locked）随 T7 认证层接入,这里先按 T3 规则映射。
 */
import type { InstanceRecord, InstanceRuntimeStatus, Transport } from '@shared/contracts'
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
  label: string
  chipClass: string
  dotClass: string
  icon: IconName
}

export const STATUS_INFO: Record<DisplayStatus, DisplayStatusInfo> = {
  idle: { label: '未连接', chipClass: 'c-idle', dotClass: '', icon: 'wifi' },
  connecting: { label: '连接中', chipClass: 'c-info', dotClass: 's-connecting', icon: 'refresh' },
  auth: { label: '需要登录', chipClass: 'c-warn', dotClass: 's-auth', icon: 'key' },
  connected: { label: '已连接', chipClass: 'c-ok', dotClass: 's-connected', icon: 'check' },
  interrupted: { label: '重连中', chipClass: 'c-warn', dotClass: 's-interrupted', icon: 'wifi' },
  error: { label: '连接错误', chipClass: 'c-err', dotClass: 's-error', icon: 'alert' },
  locked: { label: '已锁定', chipClass: 'c-err', dotClass: 's-locked', icon: 'lock' }
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

export const TYPE_INFO: Record<Transport, { label: string; icon: IconName }> = {
  local: { label: '本地', icon: 'local' },
  ssh: { label: 'SSH', icon: 'ssh' },
  http: { label: '远程', icon: 'remote' }
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

/** 运行时长(毫秒)→ 人类可读;未运行返回 null */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}