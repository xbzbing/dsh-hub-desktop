import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { useAppStore } from '../store'

/** 空态(设计稿 view-empty) */
export default function EmptyView(): ReactNode {
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  return (
    <section data-od-id="view-empty" data-testid="view-empty">
      <div className="empty">
        <span className="glyph">
          <Icon name="hub" size={76} />
        </span>
        <h2>还没有实例</h2>
        <p>添加一个本机实例开始用，或者通过 SSH / 网址连接服务器上已经在跑的 dsh。</p>
        <button
          className="btn btn-primary"
          style={{ marginTop: 4 }}
          onClick={() => setWizardOpen(true)}
          data-testid="empty-new-btn"
        >
          新建第一个实例
        </button>
        <p className="meta">快捷键 ⌘N</p>
      </div>
    </section>
  )
}