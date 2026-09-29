/**
 * 开关（switch）：用于「启用/禁用」这类即时生效的二元状态。
 *
 * 语义用 `role="switch"` + `aria-checked` 表达（读屏可识别），外观是带滑块的胶囊。
 * 状态由外部持有（受控组件），点击即回调目标状态，不做本地状态。
 */
import type { ReactNode } from 'react'

export interface SwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** 悬停说明（不可用时用于解释原因）。 */
  title?: string
  /** 读屏名称；无可见文字时必填。 */
  ariaLabel?: string
  testId?: string
}

export default function Switch(props: SwitchProps): ReactNode {
  const { checked, onChange, disabled = false, title, ariaLabel, testId } = props
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className="switch"
      data-checked={checked}
      disabled={disabled}
      {...(title === undefined ? {} : { title })}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  )
}
