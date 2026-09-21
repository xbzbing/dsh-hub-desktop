import { useEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

/** 浮层容器:背景模糊 + 居中,点击背景关闭 */
export function Modal(props: {
  wide?: boolean
  title: string
  sub?: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
  testId?: string
  /** 将浮层限制在右侧主内容区，而非覆盖整个应用。 */
  scope?: 'app' | 'workspace'
  /** 关闭按钮的无障碍标签(由调用方经 t('common.close') 传入,保持本组件无 i18n 依赖) */
  closeLabel?: string
  /** 将焦点置于对话框本身，使 Tab 的第一个停靠点是正文内第一个按钮。 */
  initialFocus?: 'dialog' | 'close'
  /** 对话框已有 Escape 关闭语义时，可把右上角关闭按钮移出 Tab 顺序。 */
  closeButtonInTabOrder?: boolean
}): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (props.initialFocus === 'dialog') dialogRef.current?.focus()
  }, [props.initialFocus])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      props.onClose()
    }
  }

  return (
    <div className={`overlay${props.scope === 'workspace' ? ' overlay-workspace' : ''}`} onClick={props.onClose}>
      <div
        ref={dialogRef}
        tabIndex={props.initialFocus === 'dialog' ? -1 : undefined}
        className={`modal${props.wide ? ' wide' : ''}`}
        data-testid={props.testId}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <div>
            <h2>{props.title}</h2>
            {props.sub && <p className="sub">{props.sub}</p>}
          </div>
          <button
            className="x-btn"
            aria-label={props.closeLabel ?? 'Close'}
            tabIndex={props.closeButtonInTabOrder === false ? -1 : undefined}
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}