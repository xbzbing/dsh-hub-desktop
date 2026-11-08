/**
 * 下拉选择：输入框样式的触发器 + 浮层菜单。
 *
 * 浮层挂在 body 上（fixed 定位），不会被对话框的滚动容器裁切；
 * 菜单规范沿用 dsh：4px 内边距、34px 行高、选中项右侧勾选、悬停/键盘同一层高亮。
 * 焦点始终留在触发器上，菜单项通过 aria-activedescendant 暴露给读屏。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { initialActiveIndex, moveActive, placeMenu } from '../lib/select-menu'
import type { MenuPlacement } from '../lib/select-menu'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps {
  /** 触发器 id，配合 `<label htmlFor>` 使用。 */
  id?: string
  /** 没有可见 label 时（如折叠小节的标题即字段名）给读屏用的名称。 */
  ariaLabel?: string
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /** 触发器附加类名（如 num：版本号、端口用等宽字体）。 */
  className?: string
  /** 触发器 test id；浮层派生为 `${testId}-menu`，选项带 data-value。 */
  testId?: string
}

export default function Select(props: SelectProps): ReactNode {
  const { id, ariaLabel, value, options, onChange, disabled = false, className, testId } = props
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  /** 键盘/指针是否已明确指向某项：刚打开时不画高亮，与 dsh 菜单一致。 */
  const [highlight, setHighlight] = useState(false)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const currentLabel = options.find((option) => option.value === value)?.label ?? value

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false)
    setHighlight(false)
    setPlacement(null)
    if (focusTrigger) triggerRef.current?.focus()
  }, [])

  const openMenu = useCallback(() => {
    if (disabled || options.length === 0) return
    setActive(initialActiveIndex(options, value))
    setHighlight(false)
    setOpen(true)
  }, [disabled, options, value])

  const choose = useCallback(
    (option: SelectOption) => {
      if (option.disabled === true) return
      close(true)
      if (option.value !== value) onChange(option.value)
    },
    [close, onChange, value]
  )

  // 打开后量一次浮层尺寸再落位；滚动/缩放时跟着触发器走。
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const trigger = triggerRef.current
      const menu = menuRef.current
      if (trigger === null || menu === null) return
      setPlacement(
        placeMenu(
          trigger.getBoundingClientRect(),
          { width: menu.offsetWidth, height: menu.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight }
        )
      )
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // 点触发器与浮层之外的地方收起。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) === true) return
      if (menuRef.current?.contains(target) === true) return
      close(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [close, open])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        if (!open) {
          openMenu()
          return
        }
        setActive((index) => moveActive(index, event.key === 'ArrowDown' ? 1 : -1, options))
        setHighlight(true)
        return
      }
      case 'Enter':
      case ' ': {
        event.preventDefault()
        if (!open) {
          openMenu()
          return
        }
        const option = options[active]
        if (option !== undefined) choose(option)
        return
      }
      case 'Home':
      case 'End': {
        if (!open) return
        event.preventDefault()
        setActive(event.key === 'Home' ? 0 : options.length - 1)
        setHighlight(true)
        return
      }
      case 'Escape': {
        if (!open) return
        event.preventDefault()
        // 菜单在对话框里打开时，Esc 只收菜单；不拦下会连对话框一起关掉。
        event.stopPropagation()
        close(true)
        return
      }
      case 'Tab': {
        if (open) close(false)
        return
      }
      default:
        return
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        aria-label={ariaLabel}
        className={className === undefined ? 'select-trigger' : `select-trigger ${className}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open ? `${menuId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onKeyDown}
        data-testid={testId}
        data-value={value}
      >
        <span className="select-value">{currentLabel}</span>
        <Icon name="chevron-down" size={14} className="select-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="listbox"
            className="select-menu"
            data-testid={testId === undefined ? undefined : `${testId}-menu`}
            style={{
              left: placement?.left ?? 0,
              top: placement?.top ?? 0,
              minWidth: placement?.minWidth ?? 144,
              visibility: placement === null ? 'hidden' : 'visible'
            }}
            onMouseLeave={() => setHighlight(false)}
            // 浮层内按下不抢焦点：键盘（Esc/方向键）始终作用于触发器。
            onMouseDown={(event) => event.preventDefault()}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${menuId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled === true ? true : undefined}
                className={
                  highlight && index === active ? 'select-option is-active' : 'select-option'
                }
                data-value={option.value}
                onMouseEnter={() => {
                  setActive(index)
                  setHighlight(true)
                }}
                onClick={() => choose(option)}
              >
                <span className="select-option-label">{option.label}</span>
                {option.value === value && <Icon name="check" size={14} className="select-check" />}
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
