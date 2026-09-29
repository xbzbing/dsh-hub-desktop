/**
 * 插件卡片的纯展示派生（保持无副作用，便于测试）：升级按钮是否可见、检查结果文案分支、
 * host 半判定、类型标签选择。UI 组件只消费这里的判定结果，不内联条件逻辑。
 */
import type { PluginInfo, PluginUpdateCheck } from '@shared/contracts'
import type { MessageKey } from '@shared/i18n/messages'

/** 单个插件行的检查态：未检查 / 检查中 / 已出结果 / 检查失败。 */
export interface PluginCheckState {
  status: 'idle' | 'checking' | 'done' | 'error'
  result: PluginUpdateCheck | null
  error: string | null
}

export const initialCheckState: PluginCheckState = { status: 'idle', result: null, error: null }

/** 是否展示「升级到 x」按钮：检查完成、有新版且兼容。 */
export function canOfferUpgrade(check: PluginCheckState): boolean {
  return (
    check.status === 'done' &&
    check.result !== null &&
    check.result.hasUpdate &&
    check.result.compatible
  )
}

/** 是否展示不兼容警告：检查完成、有新版但不兼容。 */
export function showsIncompatibleWarning(check: PluginCheckState): boolean {
  return (
    check.status === 'done' &&
    check.result !== null &&
    check.result.hasUpdate &&
    !check.result.compatible
  )
}

/** 是否展示「已是最新」：检查完成且无新版。 */
export function showsUpToDate(check: PluginCheckState): boolean {
  return check.status === 'done' && check.result !== null && !check.result.hasUpdate
}

/** 插件类型的 i18n 键选择（host+client / 仅 client / 仅 host / 无）。 */
export function pluginKindKey(plugin: Pick<PluginInfo, 'hasHostSide' | 'hasClientSide'>): MessageKey {
  if (plugin.hasHostSide && plugin.hasClientSide) return 'detail.plugin.kind.hostClient'
  if (plugin.hasClientSide) return 'detail.plugin.kind.clientOnly'
  if (plugin.hasHostSide) return 'detail.plugin.kind.hostOnly'
  return 'detail.plugin.kind.none'
}

/** 安装来源的 i18n 键选择。 */
export function pluginSourceKey(source: PluginInfo['installSource']): MessageKey {
  switch (source) {
    case 'npm':
      return 'detail.plugin.source.npm'
    case 'github':
      return 'detail.plugin.source.github'
    case 'file':
      return 'detail.plugin.source.file'
    default:
      return 'detail.plugin.source.unknown'
  }
}
