/**
 * 设置持久化（T11）—— 只依赖 node:fs,不 import electron。
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

    async update(patch) {
      const next = normalizeSettings({ ...read(), ...patch })
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await rename(tmp, path)
      cache = next
      return next
    }
  }
}
