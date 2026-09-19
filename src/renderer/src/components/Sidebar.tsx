import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InstanceSummary, Transport } from '@shared/contracts'
import { Icon } from '../lib/icons'
import logoUrl from '../../../../design/dsh-hub-logo.svg'
import { STATUS_INFO, TYPE_INFO, toDisplayStatus } from '../lib/format'
import { useAppStore } from '../store'

/** 侧边栏:品牌 / 搜索 / 分组 / 实例列表 / 底部操作 */
export default function Sidebar(): ReactNode {
  const t = useAppStore((state) => state.t)
  const instances = useAppStore((state) => state.instances)
  const selection = useAppStore((state) => state.selection)
  const rail = useAppStore((state) => state.rail)
  const theme = useAppStore((state) => state.theme)
  const select = useAppStore((state) => state.select)
  const openFromSidebar = useAppStore((state) => state.openFromSidebar)
  const toggleRail = useAppStore((state) => state.toggleRail)
  const toggleTheme = useAppStore((state) => state.toggleTheme)
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen)

  const [query, setQuery] = useState('')
  const [groupByType, setGroupByType] = useState(false)
  const hoveredInstanceRef = useRef<{ element: HTMLButtonElement; name: string } | null>(null)

  const showRailTooltip = (element: HTMLButtonElement, name: string): void => {
    hoveredInstanceRef.current = { element, name }
    if (!rail) return
    const rect = element.getBoundingClientRect()
    void window.dshHub?.runtime.showTooltip({ text: name, x: 72, y: Math.round(rect.top + rect.height / 2) })
  }

  const hideRailTooltip = (): void => {
    hoveredInstanceRef.current = null
    void window.dshHub?.runtime.hideTooltip()
  }

  useEffect(() => {
    if (!rail || !hoveredInstanceRef.current) {
      void window.dshHub?.runtime.hideTooltip()
      return
    }
    const frame = requestAnimationFrame(() => {
      const hovered = hoveredInstanceRef.current
      if (!hovered) return
      const rect = hovered.element.getBoundingClientRect()
      void window.dshHub?.runtime.showTooltip({
        text: hovered.name,
        x: 72,
        y: Math.round(rect.top + rect.height / 2)
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [rail])

  // 窗口失焦时清除悬停状态，防止切换应用后提示窗残留。
  useEffect(() => {
    const onBlur = (): void => {
      hoveredInstanceRef.current = null
      void window.dshHub?.runtime.hideTooltip()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  useEffect(() => () => void window.dshHub?.runtime.hideTooltip(), [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return instances
    return instances.filter(
      (item) => item.name.toLowerCase().includes(q) || item.address.toLowerCase().includes(q)
    )
  }, [instances, query])

  const grouped = useMemo(() => {
    if (!groupByType) return null
    const order: Transport[] = ['local', 'ssh', 'http']
    return order
      .map((transport) => ({
        transport,
        items: filtered.filter((item) => item.transport === transport)
      }))
      .filter((group) => group.items.length > 0)
  }, [filtered, groupByType])

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="side-head">
        <button
          className="brand"
          onClick={() => select(null)}
          title={t('nav.backToWorkbench')}
          data-testid="brand"
        >
          <span className="brand-mark">
            <img src={logoUrl} alt="" />
          </span>
          <span className="brand-text">
            <b>DSH Hub</b>
            <em>{t('nav.brandTagline')}</em>
          </span>
        </button>
      </div>
      <div className="side-tools">
        <label className="search">
          <Icon name="search" />
          <input
            type="search"
            placeholder={t('nav.searchPlaceholder')}
            aria-label={t('nav.searchLabel')}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="seg" role="group" aria-label={t('nav.groupBy')}>
          <button aria-pressed={!groupByType} onClick={() => setGroupByType(false)}>
            {t('nav.groupMixed')}
          </button>
          <button aria-pressed={groupByType} onClick={() => setGroupByType(true)}>
            {t('nav.groupByType')}
          </button>
        </div>
      </div>
      <nav className="side-scroll" aria-label={t('nav.instanceList')}>
        {grouped ? (
          grouped.map((group) => (
            <div key={group.transport}>
              <div className="group-head">
                <span>
                  {t(TYPE_INFO[group.transport].labelKey)} · {group.items.length}
                </span>
              </div>
              {group.items.map((item) => (
                <InstanceItem
                  key={item.id}
                  item={item}
                  onClick={openFromSidebar}
                  selected={selection === item.id}
                  rail={rail}
                  onRailTooltip={showRailTooltip}
                  onRailTooltipHide={hideRailTooltip}
                />
              ))}
            </div>
          ))
        ) : (
          filtered.map((item) => (
            <InstanceItem
              key={item.id}
              item={item}
              onClick={openFromSidebar}
              selected={selection === item.id}
              rail={rail}
              onRailTooltip={showRailTooltip}
              onRailTooltipHide={hideRailTooltip}
            />
          ))
        )}
      </nav>
      <div className="side-foot">
        <button
          className="btn btn-primary btn-block"
          onClick={() => setWizardOpen(true)}
          data-testid="new-instance-btn"
        >
          <span className="fx-icon">
            <Icon name="plus" />
          </span>
          <span className="fx-label">{t('nav.newInstance')}</span>
        </button>
        <div className="row">
          <button
            className="btn btn-ghost btn-sm"
            data-testid="settings-btn"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="gear" />
            <span className="fx-label">{t('nav.settings')}</span>
          </button>
          <button
            className="btn btn-ghost btn-sm icon-btn"
            title={theme === 'light' ? t('nav.toDark') : t('nav.toLight')}
            onClick={toggleTheme}
            data-testid="theme-toggle"
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} />
          </button>
          <button
            className="btn btn-ghost btn-sm icon-btn collapse-btn"
            aria-label={rail ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
            title={`${rail ? t('nav.expandSidebar') : t('nav.collapseSidebar')} (⌘B)`}
            onClick={toggleRail}
            data-testid="sidebar-collapse-btn"
          >
            <Icon name={rail ? 'expand' : 'collapse'} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function InstanceItem(props: {
  item: InstanceSummary
  selected: boolean
  rail: boolean
  onClick: (id: string) => void
  onRailTooltip: (element: HTMLButtonElement, name: string) => void
  onRailTooltipHide: () => void
}): ReactNode {
  const t = useAppStore((state) => state.t)
  const statuses = useAppStore((state) => state.statuses)
  const workspaceConnected = useAppStore((state) => state.workspaceConnected)
  const display = toDisplayStatus(statuses[props.item.id]?.status, workspaceConnected[props.item.id] ?? true)
  const info = STATUS_INFO[display]
  return (
    <button
      className="inst"
      aria-current={props.selected}
      onClick={() => props.onClick(props.item.id)}
      onPointerEnter={(event) => props.onRailTooltip(event.currentTarget, props.item.name)}
      onPointerLeave={props.onRailTooltipHide}
      onPointerCancel={props.onRailTooltipHide}
      onFocus={(event) => props.onRailTooltip(event.currentTarget, props.item.name)}
      onBlur={props.onRailTooltipHide}
      data-testid={`inst-${props.item.id}`}
      title={props.rail ? props.item.name : props.item.address}
    >
      <span className={`status-dot ${info.dotClass}`} aria-hidden="true" />
      <span className="inst-text">
        <span className="inst-name">{props.item.name}</span>
        <span className="inst-meta num">{props.item.address}</span>
      </span>
      <span className="badge">
        <Icon name={TYPE_INFO[props.item.transport].icon} size={11} />
        <span className="type-label">{t(TYPE_INFO[props.item.transport].labelKey)}</span>
      </span>
    </button>
  )
}