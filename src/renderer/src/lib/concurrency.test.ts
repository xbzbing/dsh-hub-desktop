import { describe, expect, it } from 'vitest'
import { runWithConcurrency } from './concurrency'

/** 让出事件循环，模拟异步任务。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('runWithConcurrency（有界并发）', () => {
  it('并发不超过 limit，且所有任务都执行一次', async () => {
    const items = Array.from({ length: 10 }, (_, index) => index)
    const seen: number[] = []
    let running = 0
    let peak = 0
    await runWithConcurrency(items, 3, async (item) => {
      running += 1
      peak = Math.max(peak, running)
      seen.push(item)
      await tick()
      running -= 1
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
    expect([...seen].sort((a, b) => a - b)).toEqual(items)
  })

  it('limit 大于任务数时按任务数并发，不空转', async () => {
    let peak = 0
    let running = 0
    await runWithConcurrency([1, 2], 8, async () => {
      running += 1
      peak = Math.max(peak, running)
      await tick()
      running -= 1
    })
    expect(peak).toBe(2)
  })

  it('空列表不执行任何任务', async () => {
    let calls = 0
    await runWithConcurrency([], 4, async () => {
      calls += 1
    })
    expect(calls).toBe(0)
  })

  it('shouldStop 置位后不再派发新任务（在跑的任其结束）', async () => {
    const started: number[] = []
    let stop = false
    await runWithConcurrency(
      [0, 1, 2, 3, 4, 5],
      1,
      async (item) => {
        started.push(item)
        if (item === 1) stop = true
        await tick()
      },
      () => stop
    )
    expect(started).toEqual([0, 1])
  })
})
