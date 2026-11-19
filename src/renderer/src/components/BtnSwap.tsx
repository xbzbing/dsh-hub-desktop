import type { ReactNode } from 'react'

/**
 * 同一按钮内的两段候选文案：叠放在同一 grid 单元，宽度取最长者，切换不跳动。
 * 不可见的一段用 aria-hidden 移出无障碍树——CSS 的 opacity 占位不会移除它。
 */
export function BtnSwap(props: {
  active: 'idle' | 'busy'
  idle: ReactNode
  busy: ReactNode
}): ReactNode {
  const idleActive = props.active === 'idle'
  return (
    <span className="btn-swap">
      <span className="btn-swap-cell" data-active={idleActive} aria-hidden={!idleActive}>
        {props.idle}
      </span>
      <span className="btn-swap-cell" data-active={!idleActive} aria-hidden={idleActive}>
        {props.busy}
      </span>
    </span>
  )
}
