import type { ReactNode } from 'react'

/** 浮层容器:背景模糊 + 居中,点击背景关闭 */
export function Modal(props: {
  wide?: boolean
  title: string
  sub?: string
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
  testId?: string
  /** 关闭按钮的无障碍标签(由调用方经 t('common.close') 传入,保持本组件无 i18n 依赖) */
  closeLabel?: string
}): ReactNode {
  return (
    <div className="overlay" onClick={props.onClose}>
      <div
        className={`modal${props.wide ? ' wide' : ''}`}
        data-testid={props.testId}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{props.title}</h2>
            {props.sub && <p className="sub">{props.sub}</p>}
          </div>
          <button className="x-btn" aria-label={props.closeLabel ?? 'Close'} onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}