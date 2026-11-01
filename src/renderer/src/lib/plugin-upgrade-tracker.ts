/**
 * 后台插件升级的在飞登记表（渲染层模块级，跨组件挂载存活）。
 *
 * 「放到后台」收起确认框后，升级仍由发起它的插件卡执行。用户此时可以切到设置页或别的实例，
 * 插件卡随之卸载；重新挂载的插件卡据此仍能认出这行在升级：锁住该行，并在升级结束后刷新列表。
 * 只登记本窗口内发起的升级；窗口重载后由主进程继续执行，界面不再追踪。
 */

/** 同一实例同一插件同一时刻只允许一次升级，键按实例隔离。 */
const inFlight = new Map<string, Promise<unknown>>()

const keyOf = (instanceId: string, name: string): string => `${instanceId}\u0000${name}`

/** 登记一次升级；返回同一个 promise，调用方照常 await 结果。 */
export function trackPluginUpgrade<T>(
  instanceId: string,
  name: string,
  task: Promise<T>
): Promise<T> {
  const key = keyOf(instanceId, name)
  inFlight.set(key, task)
  // 先登记后等待：settle 时只清掉自己这一次，避免旧任务把新任务（同名重新发起）清掉。
  const clear = (): void => {
    if (inFlight.get(key) === task) inFlight.delete(key)
  }
  void task.then(clear, clear)
  return task
}

/** 该实例该插件是否有本窗口发起的升级仍在执行；没有返回 null。 */
export function pendingPluginUpgrade(instanceId: string, name: string): Promise<unknown> | null {
  return inFlight.get(keyOf(instanceId, name)) ?? null
}
