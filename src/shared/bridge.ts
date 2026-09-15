/**
 * 渲染进程 ↔ 主进程桥接面（白名单）。
 *
 * 框架无关：不 import electron，主进程 / 预加载 / 渲染进程共享同一份类型与通道名，
 * 符合全局规则 5（registry / transport / auth / shared 不依赖 electron）。
 *
 * T1 只承载两条探针通道（getInfo / ping）；T2 会在此基础上扩展出带 zod 边界校验的
 * 完整实例注册表通道（`registry/*`）。
 */

export const IPC = {
  /** 返回应用信息（版本 / 平台 / 数据目录），同时充当主进程存活探针 */
  info: 'app:info',
  /** 空回显，用于验证双向 IPC 通路连通 */
  ping: 'app:ping'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface AppInfo {
  /** package.json 版本（app.getVersion()） */
  appVersion: string
  platform: string
  arch: string
  /** 渲染引擎版本（Electron 内嵌 Chromium） */
  chrome: string
  electron: string
  node: string
  /** 应用数据根目录：实例注册表 / 审计日志 / 隔离的 DSH_HOME 都在其下 */
  userDataPath: string
}

export interface PingResult {
  ok: true
  /** 主进程原样回显；未传参时为 null */
  echo: string | null
  /** 主进程响应时间戳（epoch ms） */
  at: number
}

export interface DshHubBridge {
  /** 主进程返回的应用信息快照 */
  getInfo: () => Promise<AppInfo>
  /** 双向 IPC 探针 */
  ping: (message?: string) => Promise<PingResult>
}