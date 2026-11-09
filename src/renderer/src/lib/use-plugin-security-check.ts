import { useEffect, useRef, useState } from 'react'
import type {
  PluginInstallPlan,
  PluginRegistryOption,
  PluginSecurityReport
} from '@shared/contracts'
import { securityHardBlocked, securityNeedsAcknowledgement } from '@shared/plugin-security'

/** 安全检查在渲染层的取数状态；disabled 表示设置关闭，不会发起 IPC。 */
export type PluginSecurityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; report: PluginSecurityReport }
  | { status: 'error'; message: string }
  | { status: 'disabled' }

/**
 * 安装/升级确认区的安全检查取数。
 *
 * 只在 spec 与安装源确定后请求；spec 变化会作废旧请求的迟到结果。
 * 设置关闭时直接落在 disabled，不调用主进程，也不访问检查相关网络。
 */
export function usePluginSecurityCheck(input: {
  instanceId: string
  /** 已解析出的精确 spec；null = 还没有可检查的对象。 */
  spec: string | null
  registry: PluginRegistryOption
  enabled: boolean
}): { state: PluginSecurityState; refresh: () => void } {
  const { instanceId, spec, registry, enabled } = input
  const [state, setState] = useState<PluginSecurityState>(
    enabled ? { status: 'idle' } : { status: 'disabled' }
  )
  const [nonce, setNonce] = useState(0)
  /** 手动「重新检查」需要绕过主进程的 10 分钟缓存；自动取数走缓存。 */
  const manualRefresh = useRef(false)

  useEffect(() => {
    if (!enabled) {
      manualRefresh.current = false
      setState({ status: 'disabled' })
      return
    }
    if (spec === null) {
      manualRefresh.current = false
      setState({ status: 'idle' })
      return
    }
    const bridge = window.dshHub
    if (!bridge) {
      setState({ status: 'error', message: '' })
      return
    }
    const refresh = manualRefresh.current
    manualRefresh.current = false
    let cancelled = false
    setState({ status: 'loading' })
    void bridge.plugin.securityCheck(instanceId, spec, { registry, refresh }).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setState({ status: 'error', message: result.message })
        return
      }
      setState({ status: 'ready', report: result.value })
    })
    return () => {
      cancelled = true
    }
  }, [enabled, instanceId, spec, registry, nonce])

  const refresh = (): void => {
    manualRefresh.current = true
    setNonce((value) => value + 1)
  }

  return { state, refresh }
}

/**
 * 安装/升级确认区共用的安全检查派生状态：
 * 计划确定后才显示「检查中」，违规结论直接阻止提交，启发式结论需用户确认。
 */
export function usePluginPlanSecurity(input: {
  instanceId: string
  plan: PluginInstallPlan | null
  registry: PluginRegistryOption
  enabled: boolean
}) {
  const security = usePluginSecurityCheck({
    instanceId: input.instanceId,
    spec: input.plan?.installSpec ?? null,
    registry: input.registry,
    enabled: input.enabled
  })
  const report = security.state.status === 'ready' ? security.state.report : null
  return {
    security,
    checking:
      input.plan !== null &&
      (security.state.status === 'loading' || security.state.status === 'idle'),
    blockedNow: securityHardBlocked(report),
    needsAcknowledgement: securityNeedsAcknowledgement(report, security.state.status === 'error')
  }
}
