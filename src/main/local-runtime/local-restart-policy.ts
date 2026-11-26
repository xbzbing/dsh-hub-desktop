/**
 * 本机实例意外退出后的自动重启策略：纯决策，不持有定时器、不接触进程。
 *
 * 退避口径与 SSH 隧道一致：首次等待 `baseMs`，连续失败翻倍直到 `maxMs`；
 * 崩溃前已稳定运行满 `stableMs` 则从 `baseMs` 重新开始。
 *
 * 只有「从未就绪」的连续失败才计数并在达到 `maxStartFailures` 时放弃 ——
 * 坏配置（缺依赖、端口始终被占）不该无限拉起；而已经跑起来再崩溃的实例
 * 不受次数上限约束，只受退避上限约束，才能满足「一直存活」的目标。
 */

export interface RestartPolicy {
  /** 首次（以及稳定运行后）的等待时长 */
  baseMs: number
  /** 退避上限 */
  maxMs: number
  /** 连续运行多久算稳定、可重置退避 */
  stableMs: number
  /** 连续「启动后未能就绪」多少次后放弃自动重启 */
  maxStartFailures: number
}

export interface RestartProgress {
  /** 下一次重启的等待时长；稳定运行后回落 `baseMs` */
  backoffMs: number
  /** 连续「启动后未能就绪」的次数 */
  startFailures: number
  /** 最近一次就绪时刻（epoch ms）；null = 当前这次启动尚未就绪 */
  readyAt: number | null
}

export type RestartPlan =
  | { kind: 'give-up'; failures: number; progress: RestartProgress }
  | { kind: 'restart'; delayMs: number; progress: RestartProgress }

export function initialRestartProgress(policy: RestartPolicy): RestartProgress {
  return { backoffMs: policy.baseMs, startFailures: 0, readyAt: null }
}

/** 实例就绪：记录稳定计时起点，清零启动失败计数（退避留到确认稳定后再重置）。 */
export function markRestartReady(progress: RestartProgress, now: number): RestartProgress {
  return { ...progress, startFailures: 0, readyAt: now }
}

/**
 * 进程意外退出后的决策。
 *
 * @param progress 退出前的重启进度（`readyAt` 用于判断崩溃前是否稳定运行）
 * @param wasReady 退出前是否已发布过 running（由启动管线按条目就绪标记给出）
 */
export function planUnexpectedExit(
  progress: RestartProgress,
  wasReady: boolean,
  policy: RestartPolicy,
  now: number
): RestartPlan {
  const stable = progress.readyAt !== null && now - progress.readyAt >= policy.stableMs
  // 稳定运行后崩溃视为新一轮：退避回到基准，失败计数清零。
  const backoffMs = stable ? policy.baseMs : progress.backoffMs
  const startFailures = wasReady || stable ? 0 : progress.startFailures + 1

  if (!wasReady && startFailures >= policy.maxStartFailures) {
    return {
      kind: 'give-up',
      failures: startFailures,
      progress: initialRestartProgress(policy)
    }
  }

  return {
    kind: 'restart',
    delayMs: backoffMs,
    progress: {
      backoffMs: Math.min(backoffMs * 2, policy.maxMs),
      startFailures,
      readyAt: null
    }
  }
}
