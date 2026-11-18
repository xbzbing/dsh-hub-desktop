/**
 * 后台插件安装的在飞登记表（渲染层模块级，跨组件挂载存活）。
 *
 * 「放到后台」收起安装对话框后，安装仍由发起它的对话框执行。用户此时可以切到设置页或别的实例，
 * 插件卡随之卸载；重新挂载的插件卡据此仍能认出这次安装：在卡头显示在装规格，并在结束后刷新列表。
 * 只登记本窗口内发起的安装；窗口重载后由主进程继续执行，界面不再追踪。
 */

/** 一次在飞安装：spec 用于提示与排序，promise 供接管方等待结果。 */
interface TrackedInstall {
  spec: string
  promise: Promise<unknown>
}

/** 同一实例同一 spec 同一时刻只保留一次安装，键按实例隔离。 */
const inFlight = new Map<string, TrackedInstall>()

/** 登记表变化的订阅者：插件卡据此重算提示与刷新列表。 */
const listeners = new Set<() => void>()

/** 每实例的规格快照缓存；内容未变时复用同一引用，供 useSyncExternalStore 稳定比较。 */
const snapshots = new Map<string, readonly string[]>()

const keyOf = (instanceId: string, spec: string): string => `${instanceId}\u0000${spec}`

/** 逐个通知订阅者。 */
const notify = (): void => {
  for (const listener of listeners) listener()
}

/** 订阅登记表变化；返回取消订阅函数。 */
export function subscribePluginInstalls(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 该实例在飞安装的 spec 排序数组；没有安装时是空数组。
 * 内容不变时返回上一次的引用（useSyncExternalStore 的快照必须稳定），变化时冻结新数组。
 */
export function pendingPluginInstalls(instanceId: string): readonly string[] {
  const prefix = `${instanceId}\u0000`
  const specs: string[] = []
  for (const [key, entry] of inFlight) {
    if (key.startsWith(prefix)) specs.push(entry.spec)
  }
  specs.sort()
  const cached = snapshots.get(instanceId)
  if (
    cached !== undefined &&
    cached.length === specs.length &&
    cached.every((spec, index) => spec === specs[index])
  ) {
    return cached
  }
  const next: readonly string[] = Object.freeze(specs)
  snapshots.set(instanceId, next)
  return next
}

/** 登记一次安装；返回同一个 promise，调用方照常 await 结果。 */
export function trackPluginInstall<T>(
  instanceId: string,
  spec: string,
  task: Promise<T>
): Promise<T> {
  const key = keyOf(instanceId, spec)
  const tracked: TrackedInstall = { spec, promise: task }
  inFlight.set(key, tracked)
  notify()
  // 先登记后等待：settle 时只清掉自己这一次，避免旧任务把新任务（同 spec 重新发起）清掉。
  const clear = (): void => {
    if (inFlight.get(key) !== tracked) return
    inFlight.delete(key)
    notify()
  }
  void task.then(clear, clear)
  return task
}
