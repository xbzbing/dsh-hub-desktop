import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listLocalSpaces, localSpacePath } from './local-spaces'

const roots: string[] = []

async function root(): Promise<string> {
  const path = join(process.cwd(), 'hub-data', `local-spaces-${crypto.randomUUID()}`)
  roots.push(path)
  await mkdir(join(path, 'homes'), { recursive: true })
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (path) => (await import('node:fs/promises')).rm(path, { recursive: true, force: true })))
})

describe('local spaces', () => {
  it('lists only UUID-named isolated homes and their recursive size', async () => {
    const dataRoot = await root()
    const id = '11111111-1111-4111-8111-111111111111'
    await mkdir(join(dataRoot, 'homes', id, 'nested'), { recursive: true })
    await writeFile(join(dataRoot, 'homes', id, 'a.txt'), 'abc')
    await writeFile(join(dataRoot, 'homes', id, 'nested', 'b.txt'), 'defg')
    await mkdir(join(dataRoot, 'homes', 'not-an-instance'), { recursive: true })

    const spaces = await listLocalSpaces(dataRoot)
    expect(spaces).toHaveLength(1)
    const [space] = spaces
    expect(space).toMatchObject({ id, sizeBytes: 7 })
    expect(Date.parse(space!.modifiedAt)).not.toBeNaN()
  })

  it('keeps a resolved space path below the managed homes directory', async () => {
    const dataRoot = await root()
    expect(localSpacePath(dataRoot, '11111111-1111-4111-8111-111111111111')).toBe(
      join(dataRoot, 'homes', '11111111-1111-4111-8111-111111111111')
    )
  })
})
