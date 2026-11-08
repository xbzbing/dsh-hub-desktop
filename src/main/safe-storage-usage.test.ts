import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Electron 45 起同步 safeStorage API 全部废弃，调用会打印弃用警告。 */
const DEPRECATED_CALLS = [
  'safeStorage.isEncryptionAvailable(',
  'safeStorage.encryptString(',
  'safeStorage.decryptString('
] as const

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (/\.test\.tsx?$/.test(entry.name)) return []
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

describe('safeStorage 用法', () => {
  it('不调用已废弃的同步 API', () => {
    const violations: string[] = []
    for (const file of sourceFiles('src')) {
      const source = readFileSync(file, 'utf8')
      for (const call of DEPRECATED_CALLS) {
        if (source.includes(call)) violations.push(`${file}: ${call}`)
      }
    }
    expect(violations).toEqual([])
  })
})
