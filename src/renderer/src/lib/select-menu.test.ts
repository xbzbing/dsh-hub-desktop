import { describe, expect, it } from 'vitest'
import { initialActiveIndex, moveActive, placeMenu } from './select-menu'

const VIEWPORT = { width: 800, height: 600 }

/** 一个 320×32 的触发器，默认放在 (100, 100)。 */
const anchor = { top: 100, left: 100, right: 420, bottom: 132, width: 320 }

describe('placeMenu', () => {
  it('默认贴在触发器下方、左缘对齐，宽度与触发器一致', () => {
    const placement = placeMenu(anchor, { width: 200, height: 150 }, VIEWPORT)
    expect(placement).toEqual({ left: 100, top: 136, minWidth: 320 })
  })

  it('下方放不下且上方有空间时翻到上方', () => {
    const low = { top: 460, left: 100, right: 420, bottom: 492, width: 320 }
    const placement = placeMenu(low, { width: 200, height: 120 }, VIEWPORT)
    expect(placement.top).toBe(460 - 120 - 4)
  })

  it('右侧越界时右缘对齐触发器', () => {
    const right = { top: 100, left: 500, right: 780, bottom: 132, width: 280 }
    const placement = placeMenu(right, { width: 300, height: 120 }, VIEWPORT)
    expect(placement.left).toBe(780 - 300)
  })

  it('窄触发器不低于 144，宽触发器不超过 420', () => {
    const narrow = { top: 100, left: 100, right: 160, bottom: 132, width: 60 }
    expect(placeMenu(narrow, { width: 100, height: 80 }, VIEWPORT).minWidth).toBe(144)
    const wide = { top: 100, left: 40, right: 640, bottom: 132, width: 600 }
    expect(placeMenu(wide, { width: 300, height: 80 }, VIEWPORT).minWidth).toBe(420)
  })

  it('视口比浮层窄时夹在左右间距内，不横向溢出', () => {
    const narrowViewport = { width: 200, height: 600 }
    const placement = placeMenu(
      { top: 100, left: 150, right: 190, bottom: 132, width: 40 },
      { width: 300, height: 80 },
      narrowViewport
    )
    expect(placement.left).toBe(8)
    expect(placement.minWidth).toBe(144)
  })

  it('上下都放不下时整块夹进视口', () => {
    const tall = { width: 320, height: 500 }
    const placement = placeMenu(
      { top: 280, left: 100, right: 420, bottom: 312, width: 320 },
      tall,
      VIEWPORT
    )
    expect(placement.top).toBeGreaterThanOrEqual(8)
    expect(placement.top + tall.height).toBeLessThanOrEqual(VIEWPORT.height - 8)
  })
})

describe('initialActiveIndex', () => {
  const options = [{ value: 'a' }, { value: 'b' }, { value: 'c', disabled: true }, { value: 'd' }]

  it('落在当前值上', () => {
    expect(initialActiveIndex(options, 'b')).toBe(1)
  })

  it('当前值不存在或禁用时落在第一个可选项', () => {
    expect(initialActiveIndex(options, 'missing')).toBe(0)
    expect(initialActiveIndex(options, 'c')).toBe(0)
  })

  it('全部禁用时仍返回 0，避免越界', () => {
    expect(initialActiveIndex([{ value: 'a', disabled: true }], 'a')).toBe(0)
    expect(initialActiveIndex([], '')).toBe(0)
  })
})

describe('moveActive', () => {
  it('首尾循环', () => {
    expect(moveActive(2, 1, [{}, {}, {}])).toBe(0)
    expect(moveActive(0, -1, [{}, {}, {}])).toBe(2)
  })

  it('跳过禁用项', () => {
    const options = [{}, { disabled: true }, {}, {}]
    expect(moveActive(0, 1, options)).toBe(2)
    expect(moveActive(2, -1, options)).toBe(0)
  })

  it('没有可选项时保持原位', () => {
    expect(moveActive(0, 1, [])).toBe(0)
    expect(moveActive(1, 1, [{ disabled: true }, { disabled: true }])).toBe(1)
  })
})
