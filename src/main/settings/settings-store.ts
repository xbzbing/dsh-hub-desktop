/**
 *
 * `<userData>/settings.json`,原子写(tmp + rename),读取时逐字段收敛
 * (`normalizeSettings`):一个坏字段不会让整份偏好重置,文件损坏也不会让应用起不来。
 *
 * 与注册表(instance-store)刻意分开:偏好是「用户口味」,注册表是「数据资产」,
 * 两者的损坏代价与恢复策略不同 —— 偏好坏了直接用默认值即可。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '@shared/settings'

export interface SettingsStoreOptions {
  /** 落盘目录(通常 `<userData>`);文件名固定 settings.json */
  dir: string
  onError?: (error: unknown) => void
}

export interface SettingsStore {
  /** 当前设置(带缓存;首次调用读盘) */
  read(): Settings
  /** 合并补丁并落盘,返回新设置 */
  update(patch: Partial<Settings>): Promise<Settings>
  /** 落盘路径(自检/测试) */
  filePath(): string
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const onError =
    options.onError ?? ((error: unknown) => console.error('[settings] 读写失败：', error))
  const path = join(options.dir, 'settings.json')
  let cache: Settings | null = null
  /** 写入队列:保证「读-合-写」串行(见 update 的说明) */
  let tail: Promise<void> = Promise.resolve()

  function read(): Settings {
    if (cache) return cache
    if (!existsSync(path)) {
      cache = { ...DEFAULT_SETTINGS }
      return cache
    }
    try {
      cache = normalizeSettings(JSON.parse(readFileSync(path, 'utf8')))
    } catch (error) {
      // 损坏自愈:设置坏了不该拦住启动
      onError(error)
      cache = { ...DEFAULT_SETTINGS }
    }
    return cache
  }

  return {
    read,
    filePath: () => path,

    update(patch) {
      // read → merge → rename 会互相覆盖,先写入的那次改动**静默丢失**,
      // 而两次调用都返回 ok → UI 对已经消失的改动提示「已保存」。
      // 唯一临时名只能消除 ENOENT 崩溃,不能消除丢失更新;必须让整个
      // 「读-合-写」处于临界区。
      const run = async (): Promise<Settings> => {
        const next = normalizeSettings({ ...read(), ...patch })
        await mkdir(dirname(path), { recursive: true })
        const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
        await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
        await rename(tmp, path)
        cache = next
        return next
      }
      // 前一次失败不能阻断后续写入(tail 只用于排队,不传播拒绝)
      const queued = tail.then(run, run)
      tail = queued.then(
        () => undefined,
        () => undefined
      )
      return queued
    }
  }
}
