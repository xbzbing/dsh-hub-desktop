import type { DshVersionCheck, DshVersionPhase } from '@shared/contracts'
import type { MessageKey } from '@shared/i18n/messages'

/** 进度阶段 → 文案 key；error 相位走失败提示，不显示阶段文字。组件与底部信息栏共用。 */
export const PHASE_KEYS = {
  checking: 'detail.version.phase.checking',
  downloading: 'detail.version.phase.downloading',
  installing: 'detail.version.phase.installing',
  done: 'detail.version.phase.done'
} as const satisfies Record<Exclude<DshVersionPhase, 'error'>, MessageKey>

/** 不可升级原因 → 文案 key。键集与契约 reason 全集双向闭合（编译期，契约新增 reason 会先红）。 */
export const REASON_KEYS = {
  'not-local': 'detail.version.reason.notLocal',
  'runtime-external': 'detail.version.reason.runtimeExternal',
  'global-unmanaged': 'detail.version.reason.globalUnmanaged'
} as const satisfies Record<NonNullable<DshVersionCheck['reason']>, MessageKey>
