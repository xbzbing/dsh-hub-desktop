/**
 * 本机实例的 dsh 插件管理：列表、检查升级、安装、升级、卸载。
 *
 * 全部经 `dsh plugin --profile <p> <pnpm-args>` 转发（dsh 内部把 pnpm 参数原样透传，并自动
 * 维护 profile package.json 的 `dependencies` 与 `bundles` 数组）。DSH_HOME 与 profile 由
 * 主进程按实例推导，绝不采信渲染层路径；命令输出经 `redactLine` 脱敏。
 *
 * 不 import Electron：dsh 可执行入口的解析复用安装器（隔离目录）与 PATH 探测，与启动同一判据。
 */
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import type { LocalInstance } from '@shared/contracts'
import { redactLine } from '@shared/redact'
import { execFileResult } from './exec-file'
import type { CommandResult, CommandRunner } from './exec-file'
import type { RuntimeInstaller } from './runtime-installer'
import type { PathProbe } from './runtime-source'
import { githubUrlFrom, npmUrlFrom, satisfiesDshPeer } from './peer-compatibility'

/** 插件命令执行超时：pnpm 安装可能较慢，给足余量（与安装器同量级）。 */
const PLUGIN_COMMAND_TIMEOUT_MS = 10 * 60_000

/** 解析出的插件信息（渲染层展示所需字段；图标以 data-uri 内联，渲染层不碰文件系统）。 */
export interface PluginInfo {
  name: string
  version: string
  description: string | null
  author: string | null
  license: string | null
  npmUrl: string | null
  githubUrl: string | null
  iconDataUri: string | null
  /** 第三方运行时依赖名（不含 peer）。 */
  dependencies: string[]
  /** `peerDependencies["@deepseek-ai/dsh"]` 范围；null = 未声明。 */
  dshPeer: string | null
  /** `engines.node` 范围；null = 未声明。 */
  nodeEngine: string | null
  /** 含 host 半（`dsh.bundle.patch`）：改动后需重启实例。 */
  hasHostSide: boolean
  /** 含 client 半（`dsh.client`）：改动后刷新页面即可。 */
  hasClientSide: boolean
  /** 安装来源：npm registry / github / 本地 file / 未知。 */
  installSource: 'npm' | 'github' | 'file' | 'unknown'
}

/** 检查升级结果（latest 及其 dsh peer 兼容判定）。 */
export interface PluginUpdateCheck {
  name: string
  current: string
  latest: string
  hasUpdate: boolean
  /** latest 版本的 dsh peer 是否满足实例当前 dsh 版本。 */
  compatible: boolean
  /** latest 版本声明的 dsh peer 范围；null = 未声明。 */
  dshPeer: string | null
  /** 实例当前 dsh 版本；null = 未知（无法判定兼容，一律置 compatible=false）。 */
  dshVersion: string | null
  /** latest 发布时间（ISO）；null = registry 未返回。 */
  modifiedAt: string | null
}

/** 插件改动结果：是否含 host 半（决定是否提醒重启）。 */
export interface PluginMutationResult {
  hasHostSide: boolean
}

interface PluginManifest {
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
interface ProfileListEntry {
  dependencies?: Record<
    string,
    { from?: string; version?: string; resolved?: string; path?: string }
  >
}

export interface PluginManagerOptions {
  installer: RuntimeInstaller
  /** 数据根目录：隔离空间实例的 DSH_HOME 落在 `<dataRoot>/homes/<id>`。 */
  dataRoot: string
  pathProbe?: PathProbe
  /** 用户主目录来源；公共空间实例的 DSH_HOME 为 `<home>/.dsh`。缺省 os.homedir。 */
  homeDir?: () => string
  /** 默认 profile（实例未指定时）。缺省 'web'。 */
  profile?: string
  /** 命令执行器（注入便于测试）；缺省 execFileResult。 */
  run?: CommandRunner
  /** package.json 读取（注入便于测试）；缺省读磁盘。 */
  readManifest?: (dir: string) => PluginManifest | null
  /** icon 文件读取为 base64（注入便于测试）；缺省读磁盘。 */
  readIcon?: (path: string) => string | null
  /** 真实 node 解析（注入便于测试）；缺省按脚本同目录探测。 */
  resolveNode?: (scriptPath: string) => string | null
  /** Electron 自带 Node 兜底调用（缺省 execPath + ELECTRON_RUN_AS_NODE=1）。 */
  nodeInvocation?: { command: string; args: string[]; env: NodeJS.ProcessEnv }
}

export interface PluginManager {
  list(instance: LocalInstance): Promise<PluginInfo[]>
  check(instance: LocalInstance, name: string): Promise<PluginUpdateCheck>
  install(instance: LocalInstance, spec: string): Promise<PluginMutationResult>
  upgrade(instance: LocalInstance, name: string, version: string): Promise<PluginMutationResult>
  remove(instance: LocalInstance, name: string): Promise<PluginMutationResult>
}

const DSH_PEER = '@deepseek-ai/dsh'

function defaultReadManifest(dir: string): PluginManifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PluginManifest
  } catch {
    return null
  }
}

function defaultReadIcon(path: string): string | null {
  try {
    return readFileSync(path).toString('base64')
  } catch {
    return null
  }
}

/** author 字段可能是字符串或 `{ name, email }` 对象。 */
function authorName(author: unknown): string | null {
  if (typeof author === 'string') return author.trim() || null
  if (author && typeof author === 'object' && 'name' in author) {
    const name = String((author as { name: unknown }).name ?? '').trim()
    return name || null
  }
  return null
}

/** 安装来源判定：resolved 指向 registry → npm；from/version 指向 github / file。 */
function installSourceOf(entry: {
  from?: string
  version?: string
  resolved?: string
}): PluginInfo['installSource'] {
  const from = entry.from ?? ''
  const version = entry.version ?? ''
  const resolved = entry.resolved ?? ''
  if (/^(github:|git\+|git@)/.test(from) || /github\.com/.test(from) || /github\.com/.test(version)) {
    return 'github'
  }
  if (/^(file:|link:)/.test(from) || /^(file:|link:)/.test(version)) return 'file'
  if (resolved.includes('/') && /https?:\/\//.test(resolved)) return 'npm'
  // 无 resolved 但有普通语义化 version（本地 node_modules 已解析）：按 npm 处理。
  if (version !== '' && !version.includes('/')) return 'npm'
  return 'unknown'
}

/** SVG 文本 base64 → data-uri（图标恒为 svg，其它扩展一律忽略）。 */
function svgDataUri(base64: string | null): string | null {
  return base64 === null ? null : `data:image/svg+xml;base64,${base64}`
}

export function createPluginManager(options: PluginManagerOptions): PluginManager {
  const run = options.run ?? ((command, args, opts) => execFileResult(command, args, {
    env: opts?.env,
    timeout: PLUGIN_COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  }))
  const readManifest = options.readManifest ?? defaultReadManifest
  const readIcon = options.readIcon ?? defaultReadIcon
  const homeDir = options.homeDir ?? homedir
  const defaultProfile = options.profile ?? 'web'
  const resolveNode = options.resolveNode ?? defaultResolveNode
  const nodeInvocation =
    options.nodeInvocation ??
    { command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }

  /** 实例的 DSH_HOME 与 profile（与启动路径同一推导）。 */
  function homeAndProfile(instance: LocalInstance): { home: string; profile: string } {
    const home = instance.useDefaultSpace
      ? join(homeDir(), '.dsh')
      : join(options.dataRoot, 'homes', instance.id)
    return { home, profile: instance.profile ?? defaultProfile }
  }

  /**
   * 解析可执行 dsh 入口：优先 hub 隔离目录已装版本，其次 PATH 探测。
   * 插件命令只操作 profile 目录、转发 pnpm，任意 dsh 副本均可执行；此处仍尽量取实例实际使用的版本。
   */
  async function resolveDshEntry(instance: LocalInstance): Promise<string> {
    const installed = await options.installer.listInstalled().catch(() => [])
    const preferred = instance.dshVersion
    const hit =
      (preferred && installed.find((item) => item.version === preferred)) ??
      [...installed].sort((a, b) => a.version.localeCompare(b.version)).at(-1)
    if (hit) return hit.entry
    const path = options.pathProbe ? await options.pathProbe.probe().catch(() => null) : null
    if (path) return path.command
    throw new Error('未找到可用的 dsh：hub 隔离目录与 PATH 上都没有已安装的运行时')
  }

  /** 构造并执行一次插件命令；非零退出抛出脱敏后的 stderr 尾部。 */
  async function runPlugin(instance: LocalInstance, args: string[]): Promise<CommandResult> {
    const { home, profile } = homeAndProfile(instance)
    const entry = await resolveDshEntry(instance)
    const pluginArgs = ['plugin', '--profile', profile, ...args]
    const node = resolveNode(entry)
    const nodePath = node !== null ? dirname(node) : null
    const basePath = process.env.PATH ?? ''
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: nodePath !== null ? `${nodePath}${delimiter}${basePath}` : basePath,
      DSH_HOME: home
    }
    const invocation =
      node !== null
        ? { command: node, args: [...nodeInvocation.args, entry, ...pluginArgs], env }
        : entry.endsWith('.js')
          ? {
              command: nodeInvocation.command,
              args: [...nodeInvocation.args, entry, ...pluginArgs],
              env: { ...env, ...nodeInvocation.env, DSH_HOME: home }
            }
          : { command: entry, args: pluginArgs, env }
    const result = await run(invocation.command, invocation.args, { env: invocation.env })
    if (result.code !== 0) {
      const tail = redactLine(result.stderr.trim()).split('\n').slice(-8).join('\n')
      throw new Error(`dsh plugin ${args.join(' ')} 失败（exit ${result.code}）：${tail || '无 stderr'}`)
    }
    return result
  }

  /** 从安装路径读 package.json 装配 PluginInfo。 */
  function infoFromPath(
    name: string,
    entry: { from?: string; version?: string; resolved?: string; path?: string }
  ): PluginInfo {
    const manifest = (entry.path ? readManifest(entry.path) : null) ?? {}
    const dsh = manifest.dsh ?? {}
    const iconBase64 =
      entry.path && typeof manifest.icon === 'string'
        ? readIcon(resolvePath(entry.path, manifest.icon))
        : null
    return {
      name,
      version: entry.version ?? manifest.version ?? '—',
      description: manifest.description?.trim() || null,
      author: authorName(manifest.author),
      license: manifest.license?.trim() || null,
      npmUrl: npmUrlFrom(name),
      githubUrl: githubUrlFrom(manifest.repository ?? manifest.homepage ?? null),
      iconDataUri: svgDataUri(iconBase64),
      dependencies: Object.keys(manifest.dependencies ?? {}),
      dshPeer: manifest.peerDependencies?.[DSH_PEER] ?? null,
      nodeEngine: manifest.engines?.node ?? null,
      hasHostSide: typeof dsh.bundle?.patch === 'string' && dsh.bundle.patch !== '',
      hasClientSide: dsh.client !== undefined && dsh.client !== null,
      installSource: installSourceOf(entry)
    }
  }

  /** 判定一个包名当前是否含 host 半（改动后决定是否提醒重启）。 */
  async function hostSideOf(instance: LocalInstance, name: string): Promise<boolean> {
    const plugins = await list(instance)
    return plugins.find((plugin) => plugin.name === name)?.hasHostSide ?? false
  }

  async function list(instance: LocalInstance): Promise<PluginInfo[]> {
    const result = await runPlugin(instance, ['list', '--json'])
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout || '[]')
    } catch {
      throw new Error('无法解析插件列表输出')
    }
    const first = Array.isArray(parsed) ? (parsed[0] as ProfileListEntry | undefined) : undefined
    const deps = first?.dependencies ?? {}
    return Object.entries(deps)
      .map(([name, entry]) => infoFromPath(name, entry))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  return {
    list,

    async check(instance, name): Promise<PluginUpdateCheck> {
      const plugins = await list(instance)
      const current = plugins.find((plugin) => plugin.name === name)
      if (!current) throw new Error(`插件未安装：${name}`)
      // view 联网取 latest 的版本、dsh peer 与发布时间。
      const result = await runPlugin(instance, [
        'view',
        name,
        'version',
        'peerDependencies',
        'time.modified',
        '--json'
      ])
      let meta: {
        version?: string
        peerDependencies?: Record<string, string>
        'time.modified'?: string
      }
      try {
        meta = JSON.parse(result.stdout || '{}')
      } catch {
        throw new Error('无法解析插件版本信息输出')
      }
      const latest = meta.version ?? current.version
      const dshPeer = meta.peerDependencies?.[DSH_PEER] ?? null
      const dshVersion = instance.dshVersion ?? null
      return {
        name,
        current: current.version,
        latest,
        hasUpdate: latest !== current.version,
        compatible: satisfiesDshPeer(dshPeer, dshVersion),
        dshPeer,
        dshVersion,
        modifiedAt: meta['time.modified'] ?? null
      }
    },

    async install(instance, spec): Promise<PluginMutationResult> {
      await runPlugin(instance, ['add', spec])
      // 安装后按包名读元数据判 host 半：spec 可能是 name / name@ver / github: / file:，
      // 统一以列表里出现的新插件为准（含 host 半即提醒重启）。
      const plugins = await list(instance)
      const hasHostSide = plugins.some((plugin) => plugin.hasHostSide && specMatchesName(spec, plugin.name))
      return { hasHostSide }
    },

    async upgrade(instance, name, version): Promise<PluginMutationResult> {
      const hadHostSide = await hostSideOf(instance, name)
      await runPlugin(instance, ['add', `${name}@${version}`])
      return { hasHostSide: hadHostSide || (await hostSideOf(instance, name)) }
    },

    async remove(instance, name): Promise<PluginMutationResult> {
      // 卸载前先判 host 半（卸载后包已不在，读不到元数据）。
      const hasHostSide = await hostSideOf(instance, name)
      await runPlugin(instance, ['remove', name])
      return { hasHostSide }
    }
  }
}

/** spec 是否指向给定包名（近似：spec 前缀去掉 @version / 协议后与包名相等或以其结尾）。 */
function specMatchesName(spec: string, name: string): boolean {
  const trimmed = spec.trim()
  if (trimmed === name) return true
  // name@version：剥掉版本段（保留 scoped 前缀的 @）。
  const at = trimmed.lastIndexOf('@')
  if (at > 0 && trimmed.slice(0, at) === name) return true
  // github:owner/repo 或 file:path：无法从 spec 精确得包名，宽松匹配结尾。
  return trimmed.endsWith(name)
}

/** 脚本同目录探测真实 node；找不到返回 null（由调用方回退 Electron 兜底）。 */
function defaultResolveNode(scriptPath: string): string | null {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const sameDir = join(dirname(scriptPath), nodeName)
  return existsSync(sameDir) ? sameDir : null
}
