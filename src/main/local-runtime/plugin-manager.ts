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
import { mergeLoginPath, resolveLoginPathOnce } from './login-path'
import { mergeShellEnv, resolveShellEnvOnce } from './shell-env'
import { evaluateDshPeers, githubUrlFrom, npmUrlFrom } from './peer-compatibility'
import { nodeModeExecutable } from '../node-mode'

/** 插件命令执行超时：pnpm 安装可能较慢，给足余量（与安装器同量级）。 */
const PLUGIN_COMMAND_TIMEOUT_MS = 10 * 60_000

/** 解析出的插件信息（渲染层展示所需字段；图标以 data-uri 内联，渲染层不碰文件系统）。 */
export interface PluginInfo {
  name: string
  version: string
  /** 本地化标题（locale/<lang>.json 的 meta.title）；无则 null，渲染层回落包名。 */
  title: string | null
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

/** 界面语言：与 app 的 Language 一致（system 已解析为 zh|en）。 */
export type PluginLocale = 'zh' | 'en'

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
  /** locale JSON 读取（注入便于测试）；缺省读磁盘并解析。 */
  readLocale?: (path: string) => { meta?: { title?: string; description?: string } } | null
  /** 真实 node 解析（注入便于测试）；缺省按脚本同目录探测。 */
  resolveNode?: (scriptPath: string) => string | null
  /** Electron 自带 Node 兜底调用（缺省 execPath + ELECTRON_RUN_AS_NODE=1）。 */
  nodeInvocation?: { command: string; args: string[]; env: NodeJS.ProcessEnv }
  /**
   * 是否把登录 shell 完整环境合并进插件命令；false 时仅合并登录 PATH（回退）。
   * 缺省 true；由设置项 inheritShellEnv 决定，读取函数注入以便运行中改设置即时生效。
   * 与本机实例启动同源——打包后 GUI 从 Finder/Dock 启动只继承 launchd 最小 PATH，
   * pnpm/node 目录不在其中，`dsh plugin` 转发 pnpm 会「pnpm not found」而失败。
   */
  inheritShellEnv?: () => boolean
  /** 登录 shell 完整环境解析（含 .zshrc/.bashrc export）；null=不可用。缺省进程内缓存的真实解析。 */
  shellEnv?: () => Promise<Map<string, string> | null>
  /** 登录环境 PATH 解析（登录 shell / Windows 注册表）；null=不可用时回退继承 PATH。缺省进程内缓存的真实解析。 */
  loginPath?: () => Promise<string | null>
}

export interface PluginManager {
  list(instance: LocalInstance, locale?: PluginLocale): Promise<PluginInfo[]>
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

function defaultReadLocale(path: string): { meta?: { title?: string; description?: string } } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { meta?: { title?: string; description?: string } }
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
  const readLocale = options.readLocale ?? defaultReadLocale
  const homeDir = options.homeDir ?? homedir
  const defaultProfile = options.profile ?? 'web'
  const resolveNode = options.resolveNode ?? defaultResolveNode
  const nodeInvocation =
    options.nodeInvocation ??
    { command: nodeModeExecutable(), args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }
  const inheritShellEnv = options.inheritShellEnv ?? ((): boolean => true)
  const shellEnv = options.shellEnv ?? resolveShellEnvOnce
  const loginPath = options.loginPath ?? resolveLoginPathOnce

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

  /**
   * 解析子进程的基础环境：默认合并登录 shell 完整环境（含 .zshrc/.bashrc export），
   * 关闭开关 / 解析失败时回退到仅合并登录 PATH。与本机实例启动同源——保证打包后 GUI
   * 启动也能解析到 pnpm/node（`dsh plugin` 转发 pnpm 需要它们在 PATH 上）。
   */
  async function resolveBaseEnv(): Promise<NodeJS.ProcessEnv> {
    const shellEnvMap = inheritShellEnv() ? await shellEnv().catch(() => null) : null
    if (shellEnvMap !== null) return mergeShellEnv(process.env, shellEnvMap)
    const loginEnvPath = await loginPath().catch(() => null)
    return { ...process.env, PATH: mergeLoginPath(process.env.PATH ?? '', loginEnvPath) }
  }

  /** 构造并执行一次插件命令；非零退出抛出脱敏后的 stderr 尾部。 */
  async function runPlugin(instance: LocalInstance, args: string[]): Promise<CommandResult> {
    const { home, profile } = homeAndProfile(instance)
    const entry = await resolveDshEntry(instance)
    const pluginArgs = ['plugin', '--profile', profile, ...args]
    const node = resolveNode(entry)
    // 登录 shell 完整环境 / 仅登录 PATH（见 resolveBaseEnv）：打包后 GUI 启动缺 pnpm/node 目录，
    // dsh plugin 转发 pnpm 会失败；node 目录始终前置，dsh 自己 spawn 的 pnpm 也解析到同一个 node。
    const baseEnv = await resolveBaseEnv()
    const basePath = baseEnv.PATH ?? ''
    const nodePath = node !== null ? dirname(node) : null
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
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

  /**
   * 从安装路径读 package.json 装配 PluginInfo。
   * 优先用 profile 顶层 node_modules/<name>（pnpm 布局下 scoped 包的可靠位置），
   * 回退 list --json 给出的 entry.path（可能指向 .pnpm 虚拟 store，scoped 包读不到）。
   * locale：读 <dir>/locale/<lang>.json 的 meta，本地化标题与简介覆盖 package.json 的英文原值。
   */
  function infoFromPath(
    name: string,
    entry: { from?: string; version?: string; resolved?: string; path?: string },
    profileNodeModules: string,
    locale: PluginLocale
  ): PluginInfo {
    const topLevelDir = join(profileNodeModules, ...name.split('/'))
    const manifestDir = readManifest(topLevelDir) !== null ? topLevelDir : (entry.path ?? topLevelDir)
    const manifest = readManifest(manifestDir) ?? {}
    const dsh = manifest.dsh ?? {}
    const iconBase64 =
      typeof manifest.icon === 'string' ? readIcon(resolvePath(manifestDir, manifest.icon)) : null
    // locale/<lang>.json 的 meta：title 本地化插件名，description 本地化简介；缺失回落 package.json。
    const localeMeta = readLocale(join(manifestDir, 'locale', `${locale}.json`))?.meta
    const localizedTitle = localeMeta?.title?.trim() || null
    const localizedDescription = localeMeta?.description?.trim() || manifest.description?.trim() || null
    return {
      name,
      version: entry.version ?? manifest.version ?? '—',
      title: localizedTitle,
      description: localizedDescription,
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

  async function list(instance: LocalInstance, locale: PluginLocale = 'zh'): Promise<PluginInfo[]> {
    const result = await runPlugin(instance, ['list', '--json'])
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout || '[]')
    } catch {
      throw new Error('无法解析插件列表输出')
    }
    const first = Array.isArray(parsed) ? (parsed[0] as ProfileListEntry | undefined) : undefined
    const deps = first?.dependencies ?? {}
    // profile 顶层 node_modules：list --json 的 path 字段在 pnpm 布局下可能指向 .pnpm 虚拟 store，
    // scoped 包（@scope/name）在其中的 <scope>/<name> 子目录不存在；顶层软链才是可靠读取位置。
    const { home, profile } = homeAndProfile(instance)
    const profileNodeModules = join(home, 'profiles', profile, 'node_modules')
    return Object.entries(deps)
      .map(([name, entry]) => infoFromPath(name, entry, profileNodeModules, locale))
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
      const peers = meta.peerDependencies ?? {}
      const dshPeer = peers[DSH_PEER] ?? null
      const dshVersion = instance.dshVersion ?? null
      // 与 dsh 加载器同口径：主包与全部 @deepseek-ai/dsh-* 子包 peer 都要满足运行时版本，
      // 任一不满足即不兼容（0.24.1 的子包锁 ^0.2.0-rc.1，实例 0.1.7-rc.2 会被拦）。
      const incompatiblePeers = evaluateDshPeers(peers, dshVersion)
      const compatible = Object.keys(incompatiblePeers).length === 0
      return {
        name,
        current: current.version,
        latest,
        hasUpdate: latest !== current.version,
        compatible,
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
