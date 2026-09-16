import { forwardRef } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { useAppStore } from '../store'

/** Controls remain in the Hub renderer while the workspace content stays main-process owned. */
const WorkspaceToolbar = forwardRef<HTMLDivElement>(function WorkspaceToolbar(_props, ref): ReactNode {
  const t = useAppStore((state) => state.t)
  const setWorkspaceOpen = useAppStore((state) => state.setWorkspaceOpen)

  return (
    <div ref={ref} className="workspace-toolbar" data-testid="workspace-toolbar">
      <span className="meta">{t('detail.openWorkspace')}</span>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => {
          void window.dshHub?.runtime.hideView()
          setWorkspaceOpen(false)
        }}
        data-testid="workspace-back-btn"
      >
        <Icon name="back" /> {t('common.backToOverview')}
      </button>
    </div>
  )
})

export default WorkspaceToolbar
