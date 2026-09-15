/**
 * 凭据卡片策略推导（T11/T10）—— 纯函数,不 import electron/React,便于单测。
 *
 * 存在的理由:复选框的勾选态**必须**来自主进程快照。若在快照到达前就允许交互,
 * 组件会用「全 false」的兜底值提交,而 `setPolicy` 对「取消勾选」的语义是真的忘掉 ——
 * 于是会静默删除已存密码(复审 F3)。
 */
import type { VaultPolicy, VaultStatusSnapshot } from '@shared/contracts'

export const NO_POLICY: VaultPolicy = { rememberPassword: false, rememberSession: false }

/** 快照尚未到达:此时**禁止**任何提交(否则会以兜底值覆盖真实策略) */
export function policyReady(status: VaultStatusSnapshot | null): boolean {
  return status !== null
}

/** 某实例的有效策略;快照未到达时返回兜底值(仅供渲染,不可用于提交) */
export function effectivePolicy(
  status: VaultStatusSnapshot | null,
  instanceId: string
): VaultPolicy {
  return status?.policies[instanceId] ?? NO_POLICY
}

/** 是否可以在该快照下提交策略变更 */
export function canSubmitPolicy(
  status: VaultStatusSnapshot | null,
  busy: boolean
): boolean {
  return policyReady(status) && !busy
}
