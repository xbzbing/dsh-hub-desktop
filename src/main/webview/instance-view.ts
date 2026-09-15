/**
 * 实例视图打开编排（T8 接线,设计文档 §6.2）—— 不 import electron,依赖注入,便于单测。
 *
 * 评审修正(2026-09):此前 `index.ts` 先 `openInstanceWindow`(内部立刻 loadURL)、
 * **之后**才注入分区 Cookie,与 §6.2「先注入再 loadURL」相反 —— 顺序只靠回环上的时序巧合过关。
 * 现把顺序收进本模块并由 `instance-view.test.ts` 的调用序列断言锁定:
 *
 *   1. 开窗(**不自动 loadURL**)
 *   2. 装 302/401 拦截(必须在首个响应到达前就位)
 *   3. 写分区会话 Cookie
 *   4. loadURL
 *
 * 任何一步反序都会让首个 main-frame 请求打一次未带 Cookie 的 302 → /login 抖动。
 */
import { prepareInstanceView } from './cookie-import'
import type { CookieSetter } from './cookie-import'

/** 打开实例视图所需的最小窗口面(生产实现即 electron `BrowserWindow`) */
export interface InstanceViewWindow {
  loadURL(url: string): Promise<void>
  webContents: { session: { cookies: CookieSetter } }
}

export interface OpenInstanceViewDeps<W extends InstanceViewWindow> {
  /** 开窗并完成导航加固;**不得**自动 loadURL */
  createWindow(): W
  /** 装拦截层(需在 loadURL 之前调用) */
  installIntercept(win: W): void
  /** 加载失败上报(默认 console.error) */
  onLoadError?(error: unknown): void
}

export interface OpenInstanceViewArgs {
  /** 要加载的确切 URL(可能带 `?token=...`,不得重建) */
  url: string
  origin: string
  basePath: string
  /** 主进程持有的会话 Cookie;null/空值表示无会话(仅加载,交给拦截层重登) */
  cookie: { name: string; value: string; expiresAt: number | null } | null
}

/**
 * 开窗 → 装拦截 → 注入 Cookie → 加载。
 * @returns 是否在加载前成功写入了会话 Cookie
 */
export async function openInstanceView<W extends InstanceViewWindow>(
  deps: OpenInstanceViewDeps<W>,
  args: OpenInstanceViewArgs
): Promise<boolean> {
  const win = deps.createWindow()
  deps.installIntercept(win)

  const onLoadError =
    deps.onLoadError ?? ((error: unknown) => console.error('[instance-view] 加载失败：', error))
  const load = async (): Promise<void> => {
    try {
      await win.loadURL(args.url)
    } catch (error) {
      onLoadError(error)
    }
  }

  if (args.cookie === null || args.cookie.value === '') {
    await load()
    return false
  }

  return prepareInstanceView(
    win.webContents.session.cookies,
    {
      origin: args.origin,
      basePath: args.basePath,
      cookie: args.cookie
    },
    load
  )
}
