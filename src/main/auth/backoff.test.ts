import { describe, expect, it } from 'vitest'
import { createBackoff, createConcurrencyGate } from './backoff'

describe('backoff（客户端纪律）', () => {
  it('retryAfterSeconds 是唯一计时依据', () => {
    let now = 1_000_000
    const backoff = createBackoff({ now: () => now })
    backoff.recordRateLimited(45)
    expect(backoff.canAttempt()).toBe(false)
    expect(backoff.state().remainingMs).toBe(45_000)
    now += 45_001
    expect(backoff.canAttempt()).toBe(true)
  })

  it('无 retryAfterSeconds → 至少 30s 下限', () => {
    const backoff = createBackoff()
    backoff.recordRateLimited(null)
    expect(backoff.state().remainingMs).toBeGreaterThanOrEqual(30_000)
  })

  it('异常大的 retryAfterSeconds 被上限截断', () => {
    const backoff = createBackoff({ maxWaitMs: 60_000 })
    backoff.recordRateLimited(99_999)
    expect(backoff.state().remainingMs).toBe(60_000)
  })

  it('成功清除退避', () => {
    const backoff = createBackoff()
    backoff.recordRateLimited(60)
    backoff.recordSuccess()
    expect(backoff.canAttempt()).toBe(true)
    expect(backoff.state().reason).toBeNull()
  })

  it('并发闸:默认上限 2,超过则排队', async () => {
    const gate = createConcurrencyGate(2)
    let peak = 0
    const task = async (): Promise<void> => {
      peak = Math.max(peak, gate.active())
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await Promise.all([gate.run(task), gate.run(task), gate.run(task), gate.run(task)])
    expect(peak).toBeLessThanOrEqual(2)
    expect(gate.active()).toBe(0)
    expect(gate.queued()).toBe(0)
  })

  it('并发闸:上限非法则拒绝构造', () => {
    expect(() => createConcurrencyGate(0)).toThrow()
  })
})
