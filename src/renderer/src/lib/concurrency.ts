/**
 * 有界并发执行：同时最多 limit 个任务在跑，任务完成后自动从队列取下一个。
 *
 * 用于「一键检查」这类由多个独立子进程任务组成的批量操作：串行太慢，无上限并发又会
 * 同时拉起过多子进程/网络请求。`shouldStop` 在每次取新任务前判定，返回 true 即停止派发
 * （已在跑的任务任其自然结束），供「用户离开页面就中止」使用。
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean = () => false
): Promise<void> {
  const queue = [...items]
  const width = Math.max(1, Math.min(Math.floor(limit), queue.length))
  const runners: Promise<void>[] = []
  for (let index = 0; index < width; index += 1) {
    runners.push(
      (async (): Promise<void> => {
        for (;;) {
          if (shouldStop()) return
          const next = queue.shift()
          if (next === undefined) return
          await worker(next)
        }
      })()
    )
  }
  await Promise.all(runners)
}
