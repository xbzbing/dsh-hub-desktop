import type { ReactNode } from 'react'
import { Icon } from '../../lib/icons'

/**
 * 可折叠小节的标题行。
 *
 * 标题、摘要与折叠箭头同属一个按钮；右侧 `actions`（如「重新检查」）独立于按钮，
 * 折叠后仍可见。折叠只收起正文，标题里的状态徽标始终保留，便于收起后仍能判断状态。
 */
export default function SectionHead(props: {
  title: ReactNode
  /** 标题后的摘要或徽标，随标题一起点击折叠。 */
  aside?: ReactNode
  open: boolean
  onToggle: () => void
  /** 标题行右侧的独立操作，不参与折叠。 */
  actions?: ReactNode
  /** 追加到标题行的类名（用于调整外边距等布局）。 */
  className?: string
  testId?: string
}): ReactNode {
  return (
    <div className={`card-head section-head${props.className ? ` ${props.className}` : ''}`}>
      <button
        type="button"
        className="section-toggle"
        aria-expanded={props.open}
        onClick={props.onToggle}
        data-testid={props.testId}
      >
        <h3>{props.title}</h3>
        {props.aside}
        <Icon name={props.open ? 'chevron-up' : 'chevron-down'} size={15} />
      </button>
      {props.actions}
    </div>
  )
}
