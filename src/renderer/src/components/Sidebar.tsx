import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const reorderInstances = useAppStore((state) => state.reorderInstances)

  const [query, setQuery] = useState('')
  const [groupByType, setGroupByType] = useState(false)
  const hoveredInstanceRef = useRef<{ element: HTMLButtonElement; name: string } | null>(null)

  // —— 拖拽排序状态 ——
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragPosition, setDragPosition] = useState<'top' | 'bottom'>('top')
  /** 记录拖拽开始时的完整顺序，用于计算新位置 */
  const dragStartOrderRef = useRef<string[]>([])

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

  // 窗口失焦时也清理拖拽状态
  useEffect(() => {
    const onBlur = (): void => {
      setDraggedId(null)
      setDragOverId(null)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

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

  // —— 拖拽事件回调 ——

  const handleDragStart = useCallback(
    (itemId: string, event: React.DragEvent): void => {
      // 分组模式下禁用拖拽
      if (grouped) return
      setDraggedId(itemId)
      dragStartOrderRef.current = instances.map((i) => i.id)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', itemId)
    },
    [grouped, instances]
  )

  const handleDragOver = useCallback(
    (itemId: string, event: React.DragEvent): void => {
      if (!draggedId || draggedId === itemId) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      // 根据鼠标在元素中的垂直位置判断插入到上方还是下方
      const rect = event.currentTarget.getBoundingClientRect()
      const midY = rect.top + rect.height / 2
      const pos: 'top' | 'bottom' = event.clientY < midY ? 'top' : 'bottom'
      setDragOverId(itemId)
      setDragPosition(pos)
    },
    [draggedId]
  )

  const handleDrop = useCallback(
    (itemId: string): void => {
      if (!draggedId || draggedId === itemId) return
      const order = dragStartOrderRef.current.length > 0 ? dragStartOrderRef.current : instances.map((i) => i.id)
      const fromIndex = order.indexOf(draggedId)
      const toIndex = order.indexOf(itemId)
      if (fromIndex === -1 || toIndex === -1) return

      // 计算新顺序:先移除拖拽项，再插入到目标位置
      const newOrder = order.filter((id) => id !== draggedId)
      let insertAt = newOrder.indexOf(itemId)
      if (dragPosition === 'bottom') insertAt += 1
      newOrder.splice(insertAt, 0, draggedId)

      // 仅在顺序真正变化时提交
      if (newOrder.some((id, i) => id !== order[i])) {
        void reorderInstances(newOrder)
      }
      setDraggedId(null)
      setDragOverId(null)
    },
    [draggedId, dragPosition, instances, reorderInstances]
  )

  const handleDragEnd = useCallback((): void => {
    setDraggedId(null)
    setDragOverId(null)
    dragStartOrderRef.current = []
  }, [])

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
                  draggable={false}
                  onDragStart={undefined}
                  onDragOver={undefined}
                  onDrop={undefined}
                  onDragEnd={undefined}
                  dragOver={false}
                  dragPosition={undefined}
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
              draggable={!grouped}
              isDragging={draggedId === item.id}
              onDragStart={
                grouped
                  ? undefined
                  : (event) => handleDragStart(item.id, event)
              }
              onDragOver={
                grouped
                  ? undefined
                  : (event) => handleDragOver(item.id, event)
              }
              onDrop={grouped ? undefined : () => handleDrop(item.id)}
              onDragEnd={handleDragEnd}
              dragOver={dragOverId === item.id && draggedId !== item.id}
              dragPosition={dragOverId === item.id ? dragPosition : undefined}
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
  draggable: boolean
  isDragging?: boolean
  onDragStart?: (event: React.DragEvent) => void
  onDragOver?: (event: React.DragEvent) => void
  onDrop?: () => void
  onDragEnd?: () => void
  dragOver: boolean
  dragPosition?: 'top' | 'bottom'
}): ReactNode {
  const t = useAppStore((state) => state.t)
  const statuses = useAppStore((state) => state.statuses)
  const workspaceConnected = useAppStore((state) => state.workspaceConnected)
  const display = toDisplayStatus(statuses[props.item.id]?.status, workspaceConnected[props.item.id] ?? true)
  const info = STATUS_INFO[display]

  const classNames = ['inst']
  if (props.selected) classNames.push('selected')
  if (props.isDragging) classNames.push('dragging')
  if (props.dragOver) classNames.push(props.dragPosition === 'top' ? 'drag-over-top' : 'drag-over-bottom')

  return (
    <button
      className={classNames.join(' ')}
      aria-current={props.selected}
      onClick={() => props.onClick(props.item.id)}
      onPointerEnter={(event) => props.onRailTooltip(event.currentTarget, props.item.name)}
      onPointerLeave={props.onRailTooltipHide}
      onPointerCancel={props.onRailTooltipHide}
      onFocus={(event) => props.onRailTooltip(event.currentTarget, props.item.name)}
      onBlur={props.onRailTooltipHide}
      data-testid={`inst-${props.item.id}`}
      title={props.rail ? props.item.name : props.item.address}
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
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
