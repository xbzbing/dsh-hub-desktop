/**
 * 下拉浮层的纯计算：落位与键盘高亮。
 *
 * 与 DOM 解耦，输入是测得的矩形与尺寸，输出是 fixed 坐标，便于直接单测。
 */

/** 触发器在视口中的位置。 */
export interface AnchorRect {
  top: number
  left: number
  right: number
  bottom: number
  width: number
}

/** 浮层实测尺寸。 */
export interface MenuSize {
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
}

/** 浮层落位：left/top 为 fixed 坐标，minWidth 与触发器对齐。 */
export interface MenuPlacement {
  left: number
  top: number
  minWidth: number
}

/** 浮层与视口边缘的最小间距。 */
const MARGIN = 8
/** 触发器与浮层的间隙。 */
const GAP = 4
/** 浮层最小宽度（dsh 菜单规范）。 */
const MIN_WIDTH = 144
/** 浮层最大宽度：更长的选项文案由 CSS 省略。 */
const MAX_WIDTH = 420

/**
 * 计算浮层落位。
 *
 * 默认贴在触发器下方、左缘对齐；下方放不下且上方有空间时翻到上方，左右同理回推，
 * 最后夹在视口内。minWidth 取触发器宽度（不低于 144、不高于 420），
 * 让表单里的下拉与输入框同宽。
 */
export function placeMenu(anchor: AnchorRect, menu: MenuSize, viewport: Viewport): MenuPlacement {
  const minWidth = Math.min(Math.max(anchor.width, MIN_WIDTH), MAX_WIDTH)
  const available = Math.max(viewport.width - MARGIN * 2, MIN_WIDTH)
  const width = Math.min(Math.max(menu.width, minWidth), available)

  let left = anchor.left
  if (left + width > viewport.width - MARGIN) left = anchor.right - width
  left = Math.max(MARGIN, Math.min(left, viewport.width - width - MARGIN))

  const below = anchor.bottom + GAP
  const above = anchor.top - menu.height - GAP
  const fitsBelow = below + menu.height <= viewport.height - MARGIN
  const top = Math.max(
    MARGIN,
    Math.min(fitsBelow || above < MARGIN ? below : above, viewport.height - menu.height - MARGIN)
  )

  return { left, top, minWidth }
}

/** 高亮计算只关心选项是否可选中。 */
export interface ActiveOption {
  disabled?: boolean
}

/** 打开时的高亮落点：当前值优先，否则第一个可选项。 */
export function initialActiveIndex(
  options: readonly (ActiveOption & { value: string })[],
  value: string
): number {
  const selected = options.findIndex((option) => option.value === value && option.disabled !== true)
  if (selected >= 0) return selected
  const firstEnabled = options.findIndex((option) => option.disabled !== true)
  return firstEnabled >= 0 ? firstEnabled : 0
}

/** 键盘上下移动高亮：跳过禁用项，首尾循环；无可选项时保持原位。 */
export function moveActive(
  current: number,
  delta: number,
  options: readonly ActiveOption[]
): number {
  const count = options.length
  if (count === 0) return 0
  let index = current
  for (let step = 0; step < count; step += 1) {
    index = (index + delta + count) % count
    if (options[index]?.disabled !== true) return index
  }
  return Math.min(Math.max(current, 0), count - 1)
}
