/**
 * 插件 manifest / list 输出的读取与字段装配（纯函数与磁盘默认实现）。
 *
 * 从 profile 顶层 node_modules 或 list --json 的 path 读 package.json、icon、locale，
 * 装配渲染层用的 PluginInfo 字段。图标按扩展名给出 MIME（SVG/PNG/JPEG/WebP，≤256 KiB）；
 * locale meta 的本地化标题与简介覆盖 package.json 的英文原值。读取失败一律按字段缺失处理。
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginInfo } from '@shared/contracts'
import {
  dshPeerRange,
  githubUrlFrom,
  githubUrlFromGitConfig,
  npmUrlFrom
} from './peer-compatibility'

/** 界面语言：与 app 的 Language 一致（system 已解析为 zh|en）。 */
export type PluginLocale = 'zh' | 'en'

/**
 * manifest / icon / locale 的读取器：默认读磁盘，测试注入内存实现。
 * 缺省实现见 defaultReadManifest / defaultReadIcon / defaultReadLocale。
 */
export interface PluginInfoReaders {
  readManifest: (dir: string) => PluginManifest | null
  readIcon: (path: string) => string | null
  readLocale: (path: string) => { meta?: { title?: string; description?: string } } | null
  /** 读本地安装目录的 git config（用于识别 GitHub 仓库）；缺失按「不是 git 仓库」处理。 */
  readGitConfig?: (dir: string) => string | null
}

export interface PluginManifest {
  name?: string
  version?: string
  description?: string
  author?: unknown
  license?: string
  homepage?: string
  repository?: unknown
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  engines?: { node?: string }
  icon?: string
  dsh?: { bundle?: { patch?: string }; client?: unknown }
}

/** `dsh plugin list --json` 的顶层条目（只取用到的字段）。 */
export interface ProfileListEntry {
  dependencies?: Record<
    string,
    { from?: string; version?: string; resolved?: string; path?: string }
  >
}

/** 读目录下 package.json；缺失或不可解析按 null（列表降级，不报错）。 */
export function defaultReadManifest(dir: string): PluginManifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PluginManifest
  } catch {
    return null
  }
}

/** 读 icon 文件为 base64；读失败按 null（列表不带图标）。 */
export function defaultReadIcon(path: string): string | null {
  try {
    return readFileSync(path).toString('base64')
  } catch {
    return null
  }
}

/** 读 locale/<lang>.json；缺失或不可解析按 null（回落 package.json 原值）。 */
export function defaultReadLocale(
  path: string
): { meta?: { title?: string; description?: string } } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as {
      meta?: { title?: string; description?: string }
    }
  } catch {
    return null
  }
}

/**
 * 读本地安装目录的 `.git/config`；
 * 普通仓库直接读 `.git/config`，linked worktree / submodule 的 `.git` 是文件，
 * 按 `gitdir:` 指针找实际配置目录（worktree 再按 `commondir` 回到主仓库）。
 */
export function defaultReadGitConfig(dir: string): string | null {
  try {
    const dotGit = join(dir, '.git')
    const stat = statSync(dotGit)
    if (stat.isDirectory()) return readFileSync(join(dotGit, 'config'), 'utf8')
    if (!stat.isFile()) return null
    const pointer = readFileSync(dotGit, 'utf8')
    const gitdir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim()
    if (gitdir === undefined || gitdir === '') return null
    const gitDir = resolvePath(dir, gitdir)
    let configDir = gitDir
    try {
      const commonDir = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
      if (commonDir !== '') configDir = resolvePath(gitDir, commonDir)
    } catch {
      // 普通 gitdir 没有 commondir；worktree 才有。
    }
    return readFileSync(join(configDir, 'config'), 'utf8')
  } catch {
    return null
  }
}

/** author 字段可能是字符串或 `{ name, email }` 对象。 */
export function authorName(author: unknown): string | null {
  if (typeof author === 'string') return author.trim() || null
  if (author && typeof author === 'object' && 'name' in author) {
    const name = String((author as { name: unknown }).name ?? '').trim()
    return name || null
  }
  return null
}

/** 安装来源判定：resolved 指向 registry → npm；from/version 指向 github / file。 */
export function installSourceOf(entry: {
  from?: string
  version?: string
  resolved?: string
}): PluginInfo['installSource'] {
  const from = entry.from ?? ''
  const version = entry.version ?? ''
  const resolved = entry.resolved ?? ''
  if (
    /^(github:|git\+|git@)/.test(from) ||
    /github\.com/.test(from) ||
    /^(github:|git\+|git@)/.test(version) ||
    /github\.com/.test(version) ||
    /codeload\.github\.com/.test(resolved)
  ) {
    return 'github'
  }
  if (/^(file:|link:)/.test(from) || /^(file:|link:)/.test(version)) return 'file'
  if (resolved.includes('/') && /https?:\/\//.test(resolved)) return 'npm'
  // 无 resolved 但有普通语义化 version（本地 node_modules 已解析）：按 npm 处理。
  if (version !== '' && !version.includes('/')) return 'npm'
  return 'unknown'
}

/**
 * 本地 file:/link: 安装源解析出的绝对安装目录。
 * package.json 里的相对说明以 profile 目录为基准（node_modules 的父目录）；`file:` URL 按
 * URL 解析。非本地安装、空说明或无法解析时返回 null。
 */
export function installDirOf(
  entry: { from?: string; version?: string },
  profileNodeModules: string
): string | null {
  const spec = [entry.version, entry.from].find(
    (value): value is string => typeof value === 'string' && /^(file:|link:)/.test(value)
  )
  if (spec === undefined) return null
  const target = spec.replace(/^(file:|link:)/, '').trim()
  if (target === '') return null
  if (target.startsWith('//')) {
    try {
      return fileURLToPath(`file:${target}`)
    } catch {
      return null
    }
  }
  return resolvePath(dirname(profileNodeModules), target)
}

/** 插件图标支持的扩展名与对应 MIME（与 dsh 一致：SVG、PNG、JPEG、WebP）。 */
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp']
])

/** dsh 对插件图标的体积上限；超过按无图标处理，避免大图拖慢列表 IPC。 */
export const MAX_ICON_BYTES = 256 * 1024

/** 按扩展名判定图标 MIME；不支持的扩展名 → null（列表按无图标降级）。 */
export function iconMediaType(path: string): string | null {
  return ICON_MEDIA_TYPES.get(extname(path).toLowerCase()) ?? null
}

/** base64 解码后的字节数（按尾部 padding 修正）。 */
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** 图标 base64 + MIME → data-uri；没读到、类型不支持或超限 → null。 */
export function iconDataUri(base64: string | null, mediaType: string | null): string | null {
  if (base64 === null || mediaType === null) return null
  if (base64ByteLength(base64) > MAX_ICON_BYTES) return null
  return `data:${mediaType};base64,${base64}`
}

/**
 * 从安装路径读 package.json 装配 PluginInfo。
 * 优先用 profile 顶层 node_modules/<name>（pnpm 布局下 scoped 包的可靠位置），
 * 回退 list --json 给出的 entry.path（可能指向 .pnpm 虚拟 store，scoped 包读不到）。
 * locale：读 <dir>/locale/<lang>.json 的 meta，本地化标题与简介覆盖 package.json 的英文原值。
 */
export function infoFromPath(
  readers: PluginInfoReaders,
  name: string,
  entry: { from?: string; version?: string; resolved?: string; path?: string },
  profileNodeModules: string,
  locale: PluginLocale,
  bundles: readonly string[] | null
): PluginInfo {
  const topLevelDir = join(profileNodeModules, ...name.split('/'))
  const manifestDir =
    readers.readManifest(topLevelDir) !== null ? topLevelDir : (entry.path ?? topLevelDir)
  const manifest = readers.readManifest(manifestDir) ?? {}
  const dsh = manifest.dsh ?? {}
  const installSource = installSourceOf(entry)
  // 本地 file:/link: 安装时列表的 version 是安装说明（file:../path），不是版本号：已装版本取
  // 本地 package.json 的 version，读不到才回退安装说明。其余来源以列表版本为准。
  const manifestVersion = typeof manifest.version === 'string' ? manifest.version : undefined
  const version =
    installSource === 'file'
      ? (manifestVersion ?? entry.version ?? '—')
      : (entry.version ?? manifestVersion ?? '—')
  const iconPath =
    typeof manifest.icon === 'string' ? resolvePath(manifestDir, manifest.icon) : null
  const iconBase64 = iconPath === null ? null : readers.readIcon(iconPath)
  // locale/<lang>.json 的 meta：title 本地化插件名，description 本地化简介；缺失回落 package.json。
  const localeMeta = readers.readLocale(join(manifestDir, 'locale', `${locale}.json`))?.meta
  const localizedTitle = localeMeta?.title?.trim() || null
  const localizedDescription =
    localeMeta?.description?.trim() || manifest.description?.trim() || null
  const manifestGithubUrl = githubUrlFrom(manifest.repository ?? manifest.homepage ?? null)
  // GitHub 安装优先展示安装来源（from / version / resolved 任一可解析），它才是「装的是哪个仓库」；
  // 本地安装优先看本地工作树自己的 GitHub remote，其次回落到包清单声明的仓库。
  const installGithubUrl =
    githubUrlFrom(entry.from ?? null) ??
    githubUrlFrom(entry.version ?? null) ??
    githubUrlFrom(entry.resolved ?? null)
  const installDir = installDirOf(entry, profileNodeModules)
  const readGitConfig = readers.readGitConfig ?? defaultReadGitConfig
  const localGithubUrl =
    installDir === null ? null : githubUrlFromGitConfig(readGitConfig(installDir))
  const githubUrl =
    installSource === 'github'
      ? (installGithubUrl ?? manifestGithubUrl)
      : installSource === 'file'
        ? (localGithubUrl ?? manifestGithubUrl)
        : manifestGithubUrl
  return {
    name,
    version,
    title: localizedTitle,
    description: localizedDescription,
    author: authorName(manifest.author),
    license: manifest.license?.trim() || null,
    // 本地/GitHub 安装无法确认包是否已发布到 npm，不给出可能 404 的地址。
    npmUrl: installSource === 'npm' ? npmUrlFrom(name) : null,
    githubUrl,
    installDir,
    iconDataUri: iconDataUri(iconBase64, iconPath === null ? null : iconMediaType(iconPath)),
    dependencies: Object.keys(manifest.dependencies ?? {}),
    dshPeer: dshPeerRange(manifest.peerDependencies),
    nodeEngine: manifest.engines?.node ?? null,
    hasHostSide: typeof dsh.bundle?.patch === 'string' && dsh.bundle.patch !== '',
    hasClientSide: dsh.client !== undefined && dsh.client !== null,
    installSource,
    updateCheckable: installSource === 'npm',
    // 只有含 host 半（dsh.bundle.patch）的插件才由 bundles 决定加载与否；
    // 纯 client 插件随宿主 bundle 加载，无法单独禁用 → null。
    enabled:
      typeof dsh.bundle?.patch === 'string' && dsh.bundle.patch !== ''
        ? bundles === null || bundles.includes(name)
        : null,
    // 发布时间来自 registry，由 list() 用检查快照回填（这里只给出默认值）。
    publishedAt: null
  }
}
