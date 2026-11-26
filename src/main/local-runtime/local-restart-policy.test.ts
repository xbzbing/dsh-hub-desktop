import { describe, expect, it } from 'vitest'
import {
  initialRestartProgress,
  markRestartReady,
  planUnexpectedExit,
  type RestartPolicy
} from './local-restart-policy'

const POLICY: RestartPolicy = {
  baseMs: 1_000,
  maxMs: 30_000,
  stableMs: 60_000,
  maxStartFailures: 5
}

describe('planUnexpectedExit', () => {
  it('初次就绪后崩溃：从基准等待开始，下一次退避翻倍', () => {
    const ready = markRestartReady(initialRestartProgress(POLICY), 1_000)

    const plan = planUnexpectedExit(ready, true, POLICY, 2_000)

    expect(plan.kind).toBe('restart')
    if (plan.kind !== 'restart') return
    expect(plan.delayMs).toBe(1_000)
    expect(plan.progress).toEqual({ backoffMs: 2_000, startFailures: 0, readyAt: null })
  })

  it('未跑满稳定窗口的再次崩溃：沿用并翻倍退避', () => {
    const progress = { backoffMs: 4_000, startFailures: 0, readyAt: 10_000 }

    const plan = planUnexpectedExit(progress, true, POLICY, 20_000)

    expect(plan.kind).toBe('restart')
    if (plan.kind !== 'restart') return
    expect(plan.delayMs).toBe(4_000)
    expect(plan.progress.backoffMs).toBe(8_000)
  })

  it('稳定运行满窗口后崩溃：退避与失败计数一起重置', () => {
    const progress = { backoffMs: 30_000, startFailures: 0, readyAt: 1_000 }

    const plan = planUnexpectedExit(progress, true, POLICY, 61_000)

    expect(plan.kind).toBe('restart')
    if (plan.kind !== 'restart') return
    expect(plan.delayMs).toBe(1_000)
    expect(plan.progress).toEqual({ backoffMs: 2_000, startFailures: 0, readyAt: null })
  })

  it('退避封顶：达到上限后不再增长', () => {
    const progress = { backoffMs: 30_000, startFailures: 0, readyAt: null }

    const plan = planUnexpectedExit(progress, false, POLICY, 0)

    expect(plan.kind).toBe('restart')
    if (plan.kind !== 'restart') return
    expect(plan.delayMs).toBe(30_000)
    expect(plan.progress.backoffMs).toBe(30_000)
  })

  it('连续未能就绪：达到上限后放弃自动重启，并重置进度', () => {
    let progress = initialRestartProgress(POLICY)
    for (let attempt = 1; attempt < POLICY.maxStartFailures; attempt += 1) {
      const plan = planUnexpectedExit(progress, false, POLICY, 0)
      expect(plan.kind).toBe('restart')
      if (plan.kind !== 'restart') return
      expect(plan.progress.startFailures).toBe(attempt)
      progress = plan.progress
    }

    const plan = planUnexpectedExit(progress, false, POLICY, 0)

    expect(plan).toEqual({
      kind: 'give-up',
      failures: POLICY.maxStartFailures,
      progress: initialRestartProgress(POLICY)
    })
  })

  it('就绪过的进程崩溃不累计启动失败：运行过再崩溃的实例永不放弃', () => {
    const progress = { backoffMs: 8_000, startFailures: 4, readyAt: null }

    const plan = planUnexpectedExit(progress, true, POLICY, 0)

    expect(plan.kind).toBe('restart')
    if (plan.kind !== 'restart') return
    expect(plan.progress.startFailures).toBe(0)
  })

  it('markRestartReady 记录就绪时刻并清零启动失败，但保留退避', () => {
    const progress = { backoffMs: 8_000, startFailures: 3, readyAt: null }

    expect(markRestartReady(progress, 12_345)).toEqual({
      backoffMs: 8_000,
      startFailures: 0,
      readyAt: 12_345
    })
  })

  it('initialRestartProgress 从基准退避与零计数开始', () => {
    expect(initialRestartProgress(POLICY)).toEqual({
      backoffMs: POLICY.baseMs,
      startFailures: 0,
      readyAt: null
    })
  })
})
