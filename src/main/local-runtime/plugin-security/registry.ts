/**
 * 安全检查的 registry 取数：目标版本 manifest、packument（发布时间/版本数）、
 * npm 下载量与 OSV 精确版本查询。
 *
 * 只读、限量、HTTPS；tarball URL 由调用方按「与所选 registry 同源」校验后再下载。
 */
import type { PluginRegistryOption } from '@shared/contracts'
import { pluginRegistryUrl } from '@shared/settings'
import { githubUrlFrom } from '../peer-compatibility'
import { InstanceStoreError } from '../../registry/instance-store'
import { SECURITY_LIMITS } from './limits'
import type { SecurityFetcher } from './net'
import { SecurityFetchError } from './net'

export interface NpmDist {
  tarball: string | null
  integrity: string | null
  shasum: string | null
  unpackedSize: number | null
  fileCount: number | null
  hasProvenance: boolean
  hasSignatures: boolean
}

export interface NpmVersionManifest {
  name: string
  version: string
  dist: NpmDist
  scripts: Record<string, string>
  dependencies: Record<string, string>
  repositoryUrl: string | null
  deprecated: string | null
  publisher: string | null
  maintainers: string[]
}

export interface NpmPackumentInfo {
  firstPublishedAt: string | null
  versionCount: number | null
  versionPublishedAt: Record<string, string>
  maintainers: string[]
}

export interface OsvVulnerability {
  id: string
  summary: string | null
  severity: string | null
}

/** registry 档位 → 基址（唯一映射，返回值必为 https）。 */
export function registryBase(registry: PluginRegistryOption): string {
  return pluginRegistryUrl(registry).replace(/\/+$/, '')
}

/** 包名编码：scoped 包的 `/` 编码为 `%2F`，registry 路径段无歧义。 */
function packagePath(name: string): string {
  return encodeURIComponent(name)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const record = asRecord(item)
      return record !== null ? stringOf(record['name']) : null
    })
    .filter((item): item is string => item !== null)
}

function parseDist(raw: unknown): NpmDist {
  const record = asRecord(raw)
  const attestations = asRecord(record?.['attestations'])
  return {
    tarball: stringOf(record?.['tarball']),
    integrity: stringOf(record?.['integrity']),
    shasum: stringOf(record?.['shasum']),
    unpackedSize: numberOrNull(record?.['unpackedSize']),
    fileCount: numberOrNull(record?.['fileCount']),
    hasProvenance: attestations?.['provenance'] !== undefined,
    hasSignatures: Array.isArray(record?.['signatures']) && record['signatures'].length > 0
  }
}

/** 解析目标版本 manifest；字段缺失按 null/空处理，不抛。 */
export function parseVersionManifest(raw: unknown): NpmVersionManifest | null {
  const record = asRecord(raw)
  if (record === null) return null
  const name = stringOf(record['name'])
  const version = stringOf(record['version'])
  if (name === null || version === null) return null
  const user = asRecord(record['_npmUser'])
  const scripts = asRecord(record['scripts'])
  const dependencies = asRecord(record['dependencies'])
  return {
    name,
    version,
    dist: parseDist(record['dist']),
    scripts: Object.fromEntries(
      Object.entries(scripts ?? {}).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string'
      })
    ),
    dependencies: Object.fromEntries(
      Object.entries(dependencies ?? {}).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string'
      })
    ),
    repositoryUrl: githubUrlFrom(record['repository'] ?? record['homepage'] ?? null),
    deprecated: stringOf(record['deprecated']),
    publisher: stringOf(user?.['name']),
    maintainers: stringsOf(record['maintainers'])
  }
}

/** 取目标版本 manifest；404 → not-found，其余错误由编排层降级。 */
export async function fetchVersionManifest(
  fetcher: SecurityFetcher,
  registry: PluginRegistryOption,
  name: string,
  version: string
): Promise<NpmVersionManifest> {
  const url = `${registryBase(registry)}/${packagePath(name)}/${encodeURIComponent(version)}`
  let raw: unknown
  try {
    raw = await fetcher.fetchJson(url, {
      timeoutMs: SECURITY_LIMITS.requestTimeoutMs,
      maxBytes: SECURITY_LIMITS.maxManifestBytes,
      headers: { accept: 'application/json' }
    })
  } catch (error) {
    if (error instanceof SecurityFetchError && error.status === 404) {
      throw new InstanceStoreError('not-found', `版本不存在：${name}@${version}`)
    }
    throw error
  }
  const manifest = parseVersionManifest(raw)
  if (manifest === null) throw new Error(`无法解析版本元数据：${name}@${version}`)
  return manifest
}

/** 取 packument 的发布时间/版本数/维护者；失败返回 null（可选检查）。 */
export async function fetchPackument(
  fetcher: SecurityFetcher,
  registry: PluginRegistryOption,
  name: string
): Promise<NpmPackumentInfo | null> {
  try {
    const raw = await fetcher.fetchJson(`${registryBase(registry)}/${packagePath(name)}`, {
      timeoutMs: SECURITY_LIMITS.requestTimeoutMs,
      maxBytes: SECURITY_LIMITS.maxPackumentBytes,
      headers: { accept: 'application/json' }
    })
    const record = asRecord(raw)
    if (record === null) return null
    const time = asRecord(record['time'])
    const versions = asRecord(record['versions'])
    const versionPublishedAt: Record<string, string> = {}
    for (const [version, value] of Object.entries(time ?? {})) {
      if (typeof value === 'string' && value !== '') versionPublishedAt[version] = value
    }
    return {
      firstPublishedAt: stringOf(time?.['created']),
      versionCount: versions === null ? null : Object.keys(versions).length,
      versionPublishedAt,
      maintainers: stringsOf(record['maintainers'])
    }
  } catch {
    return null
  }
}

/** npm 官方近 30 天下载量；失败返回 null。 */
export async function fetchDownloads(
  fetcher: SecurityFetcher,
  name: string
): Promise<number | null> {
  try {
    const raw = await fetcher.fetchJson(
      `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`,
      {
        timeoutMs: SECURITY_LIMITS.requestTimeoutMs,
        maxBytes: SECURITY_LIMITS.maxDownloadsBytes
      }
    )
    const record = asRecord(raw)
    const count = numberOrNull(record?.['downloads'])
    return count
  } catch {
    return null
  }
}

function severityOf(record: Record<string, unknown>): string | null {
  const database = asRecord(record['database_specific'])
  const severity = stringOf(database?.['severity'])
  if (severity !== null) return severity
  return null
}

/** OSV 精确版本查询；失败返回 null（可选检查）。 */
export async function queryOsv(
  fetcher: SecurityFetcher,
  name: string,
  version: string
): Promise<OsvVulnerability[] | null> {
  try {
    const raw = await fetcher.postJson(
      'https://api.osv.dev/v1/query',
      { package: { name, ecosystem: 'npm' }, version },
      { timeoutMs: SECURITY_LIMITS.requestTimeoutMs, maxBytes: SECURITY_LIMITS.maxOsvBytes }
    )
    const record = asRecord(raw)
    const vulns = record?.['vulns']
    if (!Array.isArray(vulns)) return []
    return vulns
      .map((item) => {
        const entry = asRecord(item)
        const id = stringOf(entry?.['id'])
        if (id === null) return null
        return {
          id,
          summary: stringOf(entry?.['summary']),
          severity: entry === null ? null : severityOf(entry)
        }
      })
      .filter((item): item is OsvVulnerability => item !== null)
  } catch {
    return null
  }
}

/**
 * tarball URL 只允许所选 registry 的同源 https 地址。
 * 返回 null 表示不可下载（调用方按 unavailable 处理）。
 */
export function allowedTarballUrl(
  raw: string | null,
  registry: PluginRegistryOption
): string | null {
  if (raw === null) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  const base = new URL(pluginRegistryUrl(registry))
  if (url.hostname !== base.hostname) return null
  return url.toString()
}

/** GitHub codeload 只允许固定 host（tar.gz 下载）。 */
export function allowedCodeloadUrl(owner: string, repo: string, ref: string): string | null {
  const safeName = /^[a-zA-Z0-9_.-]+$/
  if (!safeName.test(owner) || !safeName.test(repo)) return null
  const encodedRef = encodeURIComponent(ref)
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodedRef}`
}
