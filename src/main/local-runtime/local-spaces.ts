import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export interface LocalSpaceSnapshot {
  id: string
  sizeBytes: number
  modifiedAt: string
}

export async function listLocalSpaces(dataRoot: string): Promise<LocalSpaceSnapshot[]> {
  const homesDir = join(dataRoot, 'homes')
  let entries: Dirent<string>[]
  try {
    entries = await readdir(homesDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const homesRoot = `${resolve(homesDir)}${sep}`
  const spaces = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name))
      .map(async (entry) => {
        const path = resolve(homesDir, entry.name)
        if (!path.startsWith(homesRoot)) return null
        const stats = await directoryStats(path)
        return { id: entry.name, sizeBytes: stats.sizeBytes, modifiedAt: stats.modifiedAt.toISOString() }
      })
  )
  return spaces.filter((space): space is LocalSpaceSnapshot => space !== null).sort((a, b) => a.id.localeCompare(b.id))
}

export function localSpacePath(dataRoot: string, id: string): string {
  const homesDir = resolve(dataRoot, 'homes')
  const path = resolve(homesDir, id)
  if (!path.startsWith(`${homesDir}${sep}`)) throw new Error('invalid-local-space-path')
  return path
}

async function directoryStats(path: string): Promise<{ sizeBytes: number; modifiedAt: Date }> {
  const info = await stat(path)
  let entries: Dirent<string>[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sizeBytes: 0, modifiedAt: info.mtime }
    throw error
  }
  const children = await Promise.all(
    entries.map(async (entry) => {
      const child = join(path, entry.name)
      if (entry.isDirectory()) return directoryStats(child)
      if (!entry.isFile()) return { sizeBytes: 0, modifiedAt: info.mtime }
      const childInfo = await stat(child)
      return { sizeBytes: childInfo.size, modifiedAt: childInfo.mtime }
    })
  )
  return children.reduce(
    (total, child) => ({
      sizeBytes: total.sizeBytes + child.sizeBytes,
      modifiedAt: child.modifiedAt > total.modifiedAt ? child.modifiedAt : total.modifiedAt
    }),
    { sizeBytes: 0, modifiedAt: info.mtime }
  )
}
