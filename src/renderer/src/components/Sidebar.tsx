import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Transport } from '@shared/contracts'
import { Icon } from '../lib/icons'
import { STATUS_INFO, TYPE_INFO, toDisplayStatus } from '../lib/format'
import { useAppStore } from '../store'

/** 侧边栏:品牌 / 搜索 / 分组 / 实例列表 / 底部操作 */
export default function Sidebar(): ReactNode {
  const instances = useAppStore((state) => state.instances)
  const selection = useAppStore((state) => state.selection)
  const rail = useAppStore((state) => state.rail)
  const theme = useAppStore((state) => state.theme)
  const select = useAppStore((state) => state.select)
  const toggleRail = useAppStore((state) => state.toggleRail)
  const toggleTheme = useAppStore((state) => state.toggleTheme)
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  const toast = useAppStore((state) => state.toast)

  const [query, setQuery] = useState('')
  const [groupByType, setGroupByType] = useState(false)

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
          className="collapse-btn"
          aria-label={rail ? '展开侧边栏' : '收起侧边栏'}
          title={rail ? '展开侧边栏 (⌘B)' : '收起侧边栏 (⌘B)'}
          onClick={toggleRail}
        >
          <Icon name={rail ? 'expand' : 'collapse'} />
        </button>
      </div>
      <button
        className="brand"
        onClick={() => select(null)}
        title="回到实例工作台"
        data-testid="brand"
      >
        <span className="brand-mark">
          <Icon name="hub" />
        </span>
        <span className="brand-text">
          <b>DSH Hub</b>
          <em>实例管理</em>
        </span>
      </button>
      <div className="side-tools">
        <label className="search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="搜索实例或地址"
            aria-label="搜索实例"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="seg" role="group" aria-label="列表分组方式">
          <button aria-pressed={!groupByType} onClick={() => setGroupByType(false)}>
            混排
          </button>
          <button aria-pressed={groupByType} onClick={() => setGroupByType(true)}>
            按类型分组
          </button>
        </div>
      </div>
      <nav className="side-scroll" aria-label="实例列表">
        {grouped ? (
          grouped.map((group) => (
            <div key={group.transport}>
              <div className="group-head">
                <span>
                  {TYPE_INFO[group.transport].label} · {group.items.length}
                </span>
              </div>
              {group.items.map((item) => (
                <InstanceItem key={item.id} id={item.id} onClick={select} selected={selection === item.id} />
              ))}
            </div>
          ))
        ) : (
          filtered.map((item) => (
            <InstanceItem key={item.id} id={item.id} onClick={select} selected={selection === item.id} />
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
          <span className="fx-label">新建实例</span>
        </button>
        <div className="row">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => toast('info', '设置页将在后续里程碑提供')}
          >
            <Icon name="gear" />
            <span className="fx-label">设置</span>
          </button>
          <button
            className="btn btn-ghost btn-sm icon-btn"
            title={theme === 'light' ? '切换到深色外观' : '切换到浅色外观'}
            onClick={toggleTheme}
            data-testid="theme-toggle"
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function InstanceItem(props: {
  id: string
  selected: boolean
  onClick: (id: string | null) => void
}): ReactNode {
  const statuses = useAppStore((state) => state.statuses)
  const instances = useAppStore((state) => state.instances)
  const item = instances.find((entry) => entry.id === props.id)
  if (!item) return null
  const display = toDisplayStatus(statuses[props.id]?.status)
  const info = STATUS_INFO[display]
  return (
    <button
      className="inst"
      aria-current={props.selected}
      onClick={() => props.onClick(props.id)}
      data-testid={`inst-${props.id}`}
      title={item.address}
    >
      <span className={`status-dot ${info.dotClass}`} aria-hidden="true" />
      <span className="inst-text">
        <span className="inst-name">{item.name}</span>
        <span className="inst-meta num">{item.address}</span>
      </span>
      <span className="badge">
        <Icon name={TYPE_INFO[item.transport].icon} size={11} />
        <span className="type-label">{TYPE_INFO[item.transport].label}</span>
      </span>
    </button>
  )
}