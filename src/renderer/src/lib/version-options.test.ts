import { describe, expect, it } from 'vitest'
import { buildVersionOptions } from './version-options'

const RECENT = [
  '0.1.7-alpha.2',
  '0.1.7-alpha.1',
  '0.1.6-alpha.2',
  '0.1.6-alpha.1',
  '0.1.5-rc.3',
  '0.1.5-rc.2',
  '0.1.5-rc.1',
  '0.1.5-alpha.2',
  '0.1.5-alpha.1',
  '0.1.3-alpha.2',
  '0.1.2-alpha.5',
  '0.1.2-alpha.4'
]

describe('buildVersionOptions', () => {
  it('只取最近 10 个且保持从新到旧（最新在上）', () => {
    const options = buildVersionOptions(RECENT, undefined, '')
    expect(options).toHaveLength(10)
    expect(options[0]).toBe('0.1.7-alpha.2')
    expect(options[9]).toBe('0.1.3-alpha.2')
    // 被截掉的老版本不得混入选项
    expect(options).not.toContain('0.1.2-alpha.5')
  })

  it('本地版本不在前 10 时补在末尾，默认选中始终有对应选项', () => {
    const options = buildVersionOptions(RECENT, '0.1.1-legacy', '')
    expect(options[0]).toBe('0.1.7-alpha.2')
    expect(options.at(-1)).toBe('0.1.1-legacy')
    expect(options).toHaveLength(11)
  })

  it('本地版本已在前 10 内不重复；当前选中值同样去重', () => {
    const options = buildVersionOptions(RECENT, '0.1.5-rc.1', '0.1.6-alpha.2')
    expect(options.filter((value) => value === '0.1.5-rc.1')).toHaveLength(1)
    expect(options.filter((value) => value === '0.1.6-alpha.2')).toHaveLength(1)
    expect(options).toHaveLength(10)
  })

  it('列表未就绪时只带本地版本兜底，空值一律剔除', () => {
    expect(buildVersionOptions([], '0.1.5-rc.1', '')).toEqual(['0.1.5-rc.1'])
    expect(buildVersionOptions([], undefined, '')).toEqual([])
  })

  it('limit 可调，默认 10', () => {
    expect(buildVersionOptions(RECENT, undefined, '', 3)).toHaveLength(3)
    expect(buildVersionOptions(RECENT.slice(0, 5), undefined, '')).toHaveLength(5)
  })
})
