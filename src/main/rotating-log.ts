/**
 * 按本地日历日轮转的追加日志。
 *
 * 活动文件写满一天后归档为 `<fileName>.<YYYY-MM-DD>`，`prune` 只删除严格匹配该
 * 形态且早于保留期的普通文件；目录里的其它内容一律不碰。写盘串行化，轮转在写前
 * 完成，归档用 link + unlink，避免后续 append 落进已归档文件。
 *
 * 只依赖 node:fs，不 import Electron；审计日志与主进程日志共用同一份轮转逻辑。
 */
import { appendFile, link, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000

/** 本地日历日 `YYYY-MM-DD`（归档文件名用本地日）。 */
export function localDay(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 从归档文件名解析归属日；形状合法但日期不存在（如 2026-13-45）返回 null。 */
export function dayStampFrom(name: string, pattern: RegExp): string | null {
  const stamp = pattern.exec(name)?.[1]
  if (!stamp) return null
  const [year, month, day] = stamp.split('-').map(Number) as [number, number, number]
  return localDay(new Date(year, month - 1, day)) === stamp ? stamp : null
}

export interface RotatingLogOptions {
  /** 日志目录。 */
  dir: string
  /** 活动文件名（也是归档前缀）。 */
  fileName: string
  /** 注入时钟（毫秒，测试用）。 */
  now: () => number
  /** 归档保留天数。 */
  maxAgeDays: number
  /** 写盘/清理失败上报；轮转失败不抛，交给调用方决定。 */
  onError: (error: unknown) => void
  /** 从活动文件最后一行解析归属日；返回 null 表示无法识别。 */
  dayOfLastLine: (lastLine: string) => string | null
  /** 置为 false 时丢弃尚未执行的追加（主进程日志停写后不再落盘）。 */
  canWrite?: () => boolean
}

export interface RotatingLog {
  logPath(): string
  /** 追加一行；失败时抛出，由调用方按各自的错误口径处理。 */
  appendLine(line: string): Promise<void>
  /** 等待已排队的追加完成。 */
  flush(): Promise<void>
  /** 删除过期归档；返回被删除的文件名。 */
  prune(): Promise<string[]>
}

export function createRotatingLog(options: RotatingLogOptions): RotatingLog {
  const { dir, fileName } = options
  // 归档名严格匹配 `<fileName>.<YYYY-MM-DD>`，不误删同目录的其它备份。
  const archivePattern = new RegExp(
    `^${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d{4}-\\d{2}-\\d{2})$`
  )
  const logPath = (): string => join(dir, fileName)

  let liveDay: string | null = null
  let tail: Promise<void> = Promise.resolve()

  /** 从活动文件末尾恢复归属日；文件不存在或无法识别时返回 null。 */
  async function probeLiveDay(): Promise<string | null> {
    try {
      const content = await readFile(logPath(), 'utf8')
      const lastNewline = content.lastIndexOf('\n', content.length - 2)
      const lastLine = (lastNewline >= 0 ? content.slice(lastNewline + 1) : content).trim()
      return lastLine === '' ? null : options.dayOfLastLine(lastLine)
    } catch {
      return null
    }
  }

  /** 活动文件归属日变化时改名归档；文件尚不存在等失败继续写当前文件。 */
  async function rotateIfNeeded(today: string): Promise<void> {
    if (liveDay === null || liveDay === today) {
      liveDay = today
      return
    }
    const live = logPath()
    const archive = join(dir, `${fileName}.${liveDay}`)
    try {
      await link(live, archive)
      await unlink(live)
    } catch {
      // 活动文件不存在时无需归档，后续 append 会重新创建。
    }
    liveDay = today
  }

  async function appendLine(line: string): Promise<void> {
    if (options.canWrite?.() === false) return
    const today = localDay(new Date(options.now()))
    if (liveDay === null) liveDay = await probeLiveDay()
    await mkdir(dir, { recursive: true })
    await rotateIfNeeded(today)
    await appendFile(logPath(), `${line}\n`, { mode: 0o600 })
  }

  function enqueue(line: string): Promise<void> {
    const task = tail.then(
      () => appendLine(line),
      () => appendLine(line)
    )
    // 队列自身消化失败（调用方仍拿到本次任务的拒绝），后续 flush 不会变成未处理拒绝。
    tail = task.catch(() => undefined)
    return task
  }

  return {
    logPath,
    appendLine: enqueue,
    flush: () => tail,
    async prune() {
      // 保留期按本地日历日比较：归档日 < cutoffDay 才删，避免按时刻比较跨日抖动。
      const cutoffDay = localDay(new Date(options.now() - options.maxAgeDays * DAY_MS))
      const removed: string[] = []
      try {
        const names = await readdir(dir)
        for (const name of names) {
          const stamp = dayStampFrom(name, archivePattern)
          if (!stamp || stamp >= cutoffDay) continue
          try {
            // 二次确认是普通文件，避免误删同名目录。
            const info = await stat(join(dir, name))
            if (!info.isFile()) continue
            await unlink(join(dir, name))
            removed.push(name)
          } catch (error) {
            options.onError(error)
          }
        }
      } catch (error) {
        // 目录不存在等价于无归档。
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') options.onError(error)
      }
      return removed
    }
  }
}
