import type { Translator } from '@shared/i18n'
import { fmtLogTime } from './format'
import { PHASE_KEYS } from './version-phases'
import type { ActivityLine } from '../store'

/**
 * 底部信息栏行格式（纯函数）：`yyyy-MM-dd HH:mm:ss` + 状态原文；
 * 升级进度按阶段措辞，失败与完成单独成句。
 */
export function formatActivity(t: Translator, line: ActivityLine): string {
  if (line.source === 'runtime') {
    return `${fmtLogTime(line.at)}  ${line.detail}`
  }
  const event = line.event
  const time = fmtLogTime(event.at)
  if (event.phase === 'error') {
    return `${time}  ${t('detail.version.upgradeFailed', { msg: event.error ?? t('common.unknown') })}`
  }
  const phaseText =
    event.phase === 'done'
      ? `${t(PHASE_KEYS.done)}${event.version ? ` v${event.version}` : ''}`
      : `${t(PHASE_KEYS[event.phase])}${event.detail !== undefined && event.detail !== '' ? ` · ${event.detail}` : ''}`
  return `${time}  ${phaseText}${event.detail ? `  ${event.detail}` : ''}`
}
