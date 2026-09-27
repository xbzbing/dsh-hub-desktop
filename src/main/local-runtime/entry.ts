/**
 * 运行中/接管中的本机实例条目：`launch.ts` 的 spawnAndWatch 与 `local-runtime.ts` 的 adopt
 * 共同构造，管理器持有条目表并做停止/回收。抽到叶子模块以打破 launch ↔ local-runtime 的类型环。
 */
import type { SpawnedProcess } from '../transport/spawn'

export interface Entry {
  /** hub spawn 的子进程;接管外部实例时为 null(进程归用户所有) */
  child: SpawnedProcess | null
  url: string | null
  port: number | null
  version: string
  /** 本次启动的实际命令行(命令+参数),经状态事件展示;外部接管条目没有 hub 构造的命令行 */
  command?: string
  /** 运行时来源(hub=隔离目录 / path=用户本机 PATH / external=接管外部进程) */
  runtimeSource: 'hub' | 'path' | 'external'
  home: string
  log: string[]
  /** 未以换行结尾的残片：跨 chunk 的就绪行靠它拼接，否则会漏匹配就绪行 */
  buffer: string
  ready: boolean
  stopping: boolean
  timer: NodeJS.Timeout | null
  /** 队列放行钩子:就绪 / 退出 / 出错 / 超时 任一发生时调用(TOCTOU 防线) */
  settleSpawn?: () => void
  /** 外部接管的 pid(仅展示与诊断;停止时不 kill) */
  externalPid?: number
}
