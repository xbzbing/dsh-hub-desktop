/**
 *
 * 三关(单测/类型/lint)全绿 —— 因为「该不该通知」的纯函数有测试,
 * 而**真正把通知发出去**的那一行写在 `index.ts` 里,结构上不可测。
 *
 * 这里把发送收进本模块:`notificationPlan` 仍决定「发什么/发不发」,
 * electron 的 `Notification` 只是默认实现(测试里 mock `electron`),因此
 * 「删掉 show()」会直接让本模块的单测失败。
 */
import { Notification } from 'electron'
import type { InstanceRuntimeStatus, InstanceStatusEvent } from '@shared/contracts'
import { createTranslator } from '@shared/i18n'
import { resolveLanguage } from '@shared/settings'
import type { Settings } from '@shared/settings'
import { notificationPlan } from './native-decisions'

export interface StatusNotifierDeps {
  /** 当前偏好(每次通知都重新读取:运行中可能改了语言或关掉通知) */
  readSettings(): Pick<Settings, 'language' | 'notifications'>
  /** 系统语言(`app.getLocale()`),偏好为 null 时兜底 */
  locale(): string
  /** 缺省 = electron `Notification.isSupported`(测试可注入) */
  isSupported?(): boolean
  /** 缺省 = `new Notification(...).show()`(测试可注入) */
  show?(plan: { title: string; body: string }): void
  onError?(error: unknown): void
}

export interface StatusNotifier {
  /** 按偏好与状态迁移发送系统通知;返回是否真的发送(便于测试与日志) */
  notify(event: InstanceStatusEvent, previous: InstanceRuntimeStatus | null): boolean
}

export function createStatusNotifier(deps: StatusNotifierDeps): StatusNotifier {
  function isSupported(): boolean {
    return deps.isSupported ? deps.isSupported() : Notification.isSupported()
  }

  function show(plan: { title: string; body: string }): void {
    if (deps.show) {
      deps.show(plan)
      return
    }
    new Notification({ title: plan.title, body: plan.body }).show()
  }

  return {
    notify(event, previous) {
      // 通知是旁路:文案/平台/构造任何一步失败都不能冒泡进状态流
      try {
        const settings = deps.readSettings()
        const t = createTranslator(resolveLanguage(settings.language, deps.locale()))
        const plan = notificationPlan(event, previous, settings, t)
        if (!plan) return false
        if (!isSupported()) return false
        show(plan)
        return true
      } catch (error) {
        deps.onError?.(error)
        return false
      }
    }
  }
}
