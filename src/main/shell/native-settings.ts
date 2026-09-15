/**
 * 原生设置的「动作计划」（T11）—— 纯函数,不 import electron。
 *
 * 复审反馈:托盘/自启/通知的接线全部写在 `index.ts` 的 `app.whenReady()` 内部,
 * **结构上不可测**,于是「托盘菜单不随语言刷新」「autoStart 从不落到 OS」这类缺陷
 * 可以在测试全绿的情况下存活。这里把「设置 → 该做哪些原生动作」抽成可穷举单测的计划。
 */
import type { Settings } from '@shared/settings'

export type NativeAction =
  | { kind: 'create-tray' }
  | { kind: 'destroy-tray' }
  /** 托盘已存在但文案需要刷新(如切换语言)—— 复审 R3 的缺口 */
  | { kind: 'update-tray' }
  | { kind: 'set-login-item'; autoStart: boolean }

export interface NativePlanInput {
  settings: Pick<Settings, 'tray' | 'autoStart'>
  /** 当前是否已有托盘 */
  trayExists: boolean
  /** 是否为启动时的首次应用 */
  startup: boolean
}

/**
 * 计算需要施加的原生动作。
 *
 * 约定:
 * - 托盘:关→有不留图标;不有→开则创建;**有且开则刷新文案**(语言切换后菜单不能停在旧语言);
 * - 登录项:启动时只在**需要开启**时写(避免每次启动都写一次「关闭」,在未签名环境会打权限错误);
 *   运行期的切换(含关闭)照实写入,尊重用户显式操作。
 */
export function planNativeSettings(input: NativePlanInput): NativeAction[] {
  const actions: NativeAction[] = []
  const { settings, trayExists, startup } = input

  if (settings.tray && !trayExists) actions.push({ kind: 'create-tray' })
  else if (!settings.tray && trayExists) actions.push({ kind: 'destroy-tray' })
  else if (settings.tray && trayExists) actions.push({ kind: 'update-tray' })

  if (!startup || settings.autoStart) {
    actions.push({ kind: 'set-login-item', autoStart: settings.autoStart })
  }

  return actions
}

/** 施加原生设置所需的副作用端口(生产由 electron 实现,测试用 spy) */
export interface NativeSettingsPorts {
  /** 当前是否已有托盘(每次 apply 时读取真实状态) */
  trayExists(): boolean
  createTray(): void
  destroyTray(): void
  /** 刷新已存在托盘的文案(语言切换等) */
  updateTray(): void
  setLoginItem(autoStart: boolean): void
  onError(error: unknown, action: NativeAction['kind']): void
}

/** 施加原生设置真正需要的字段(便于测试传入部分设置) */
export type NativeSettingsFields = Pick<Settings, 'tray' | 'autoStart'>

export interface NativeSettingsApplier {
  apply(settings: NativeSettingsFields, options?: { startup?: boolean }): NativeAction[]
}

/**
 * 把「动作计划」落到端口上。
 *
 * 复审指出:此前的实现把 `app.setLoginItemSettings`/`createHubTray`/`updateTrayStatus`
 * 直接写在 `index.ts` 的 `app.whenReady()` 内部,于是**效果侧结构上不可测** ——
 * 计划本身(纯函数)已被单测覆盖,但「到底有没有真的调用」没有任何测试约束,
 * M9/M14′/M17 等变异因此存活。把副作用注入进来后,这一层可以用 spy 断言。
 */
export function createNativeSettingsApplier(ports: NativeSettingsPorts): NativeSettingsApplier {
  return {
    apply(settings, options = {}) {
      const actions = planNativeSettings({
        settings,
        trayExists: ports.trayExists(),
        startup: options.startup === true
      })
      for (const action of actions) {
        try {
          switch (action.kind) {
            case 'create-tray':
              ports.createTray()
              break
            case 'destroy-tray':
              ports.destroyTray()
              break
            case 'update-tray':
              ports.updateTray()
              break
            case 'set-login-item':
              ports.setLoginItem(action.autoStart)
              break
          }
        } catch (error) {
          // 单个动作失败不影响其余动作(托盘坏了不该连自启也设不上)
          ports.onError(error, action.kind)
        }
      }
      return actions
    }
  }
}
