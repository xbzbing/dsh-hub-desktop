/**
 * 最小 tar 读取器：只解析 npm tarball 常见的 ustar/pax/GNU longname。
 *
 * 不落盘、不跟随链接、不执行任何内容；路径穿越只做标记，由调用方阻止安装。
 * 所有长度都按缓冲区边界校验，畸形/截断输入抛 `TarParseError`，由编排层降级。
 */

export type TarEntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'other'

export interface TarEntry {
  /** 归一化后的包内路径（去掉前导 `./`）。 */
  path: string
  type: TarEntryType
  /** 条目声明的字节数（文件）。 */
  size: number
  /** 文件内容；目录/链接或超过单文件上限时为 null。 */
  data: Buffer | null
  /** 路径含 `..`、绝对路径或反斜杠穿越。 */
  unsafe: boolean
  /** 符号链接/硬链接目标。 */
  linkPath: string | null
}

export interface TarLimits {
  maxEntries?: number
  maxFileBytes?: number
  maxUnpackedBytes?: number
}

export class TarParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarParseError'
  }
}

const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_UNPACKED_BYTES = 100 * 1024 * 1024
const BLOCK = 512

function readString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8')
}

function parseOctal(buffer: Buffer, offset: number, length: number): number {
  const text = readString(buffer, offset, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) {
    throw new TarParseError(`tar 头字段非法：${text}`)
  }
  return value
}

function isZeroBlock(buffer: Buffer, offset: number): boolean {
  for (let index = offset; index < offset + BLOCK; index += 1) {
    if (buffer[index] !== 0) return false
  }
  return true
}

/** 归一化并判定路径是否穿越；返回 null 表示空路径。 */
export function normalizeTarPath(raw: string): { path: string; unsafe: boolean } | null {
  let path = raw.replace(/\\/g, '/')
  while (path.startsWith('./')) path = path.slice(2)
  path = path.replace(/^\/+/, '')
  if (path === '' || path === '.') return null
  const segments = path.split('/')
  const unsafe = segments.some((segment) => segment === '..') || raw.startsWith('/')
  return { path, unsafe }
}

/** 解析 pax 扩展头里的 path/linkpath/size；无法解析的记录忽略。 */
function parsePax(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) break
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = data.subarray(space + 1, offset + length)
    const equals = record.indexOf(0x3d)
    if (equals > 0) {
      const key = record.subarray(0, equals).toString('utf8')
      const value = record
        .subarray(equals + 1)
        .toString('utf8')
        .replace(/\n$/, '')
      result[key] = value
    }
    offset += length
  }
  return result
}

/**
 * 读取 tar 条目。超过条目数/解压总量/单文件上限时抛错或把 data 置 null：
 * - 条目数、解压总量：无法安全继续，抛 `TarParseError`；
 * - 单文件超限：保留条目元信息，data=null，由扫描层标记 partial。
 */
export function readTarEntries(buffer: Buffer, limits: TarLimits = {}): TarEntry[] {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxUnpackedBytes = limits.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES
  const entries: TarEntry[] = []
  let offset = 0
  let unpacked = 0
  let pax: Record<string, string> | null = null
  let longName: string | null = null
  let longLink: string | null = null

  while (offset + BLOCK <= buffer.length) {
    if (isZeroBlock(buffer, offset)) break
    const name = readString(buffer, offset, 100)
    const prefix = readString(buffer, offset + 345, 155)
    const headerName = longName ?? pax?.['path'] ?? (prefix === '' ? name : `${prefix}/${name}`)
    const typeflag = String.fromCharCode(buffer[offset + 156] ?? 0)
    const linkPathRaw = longLink ?? pax?.['linkpath'] ?? readString(buffer, offset + 157, 100)
    const size =
      pax?.['size'] !== undefined ? Number(pax['size']) : parseOctal(buffer, offset + 124, 12)
    if (!Number.isFinite(size) || size < 0) throw new TarParseError('tar 条目长度非法')
    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) throw new TarParseError('tar 条目被截断')

    // 元数据条目先消费再继续，不进入结果。
    if (typeflag === 'x') {
      pax = parsePax(buffer.subarray(dataStart, dataEnd))
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (typeflag === 'L') {
      longName = readString(buffer, dataStart, Math.min(size, 4096))
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (typeflag === 'K') {
      longLink = readString(buffer, dataStart, Math.min(size, 4096))
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }
    if (typeflag === 'g') {
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }

    const normalized = normalizeTarPath(headerName)
    if (normalized !== null) {
      unpacked += size
      if (unpacked > maxUnpackedBytes) throw new TarParseError('tar 解压总量超过上限')
      if (entries.length >= maxEntries) throw new TarParseError('tar 条目数超过上限')
      const type: TarEntryType =
        typeflag === '5'
          ? 'directory'
          : typeflag === '2'
            ? 'symlink'
            : typeflag === '1'
              ? 'hardlink'
              : typeflag === '0' || typeflag === '\u0000'
                ? 'file'
                : 'other'
      const data =
        type === 'file' && size <= maxFileBytes ? buffer.subarray(dataStart, dataEnd) : null
      entries.push({
        path: normalized.path,
        type,
        size,
        data,
        unsafe: normalized.unsafe,
        linkPath: linkPathRaw === '' ? null : linkPathRaw
      })
    }

    pax = null
    longName = null
    longLink = null
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }

  if (entries.length === 0) throw new TarParseError('tar 包为空')
  return entries
}

/** 取包内最浅层的 package.json（兼容 GitHub codeload 的 `<repo>-<ref>/` 顶层目录）。 */
export function packageJsonEntry(entries: readonly TarEntry[]): TarEntry | null {
  const candidates = entries
    .filter((entry) => entry.type === 'file' && entry.path.endsWith('package.json'))
    .map((entry) => ({ entry, depth: entry.path.split('/').length }))
    .sort((left, right) => left.depth - right.depth)
  return candidates[0]?.entry ?? null
}
