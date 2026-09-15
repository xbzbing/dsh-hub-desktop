import type { ReactNode } from 'react'
import type { InstanceSummary } from '@shared/contracts'
import { Icon } from '../lib/icons'
import { STATUS_INFO, TYPE_INFO, toDisplayStatus } from '../lib/format'
import { useAppStore } from '../store'

/** 总览页:统计卡 + 全部实例表格(设计稿 view-home,D1 已决表格形态) */
export default function HomeView(): ReactNode {
  const loaded = useAppStore((state) => state.loaded)
  if (!loaded) return <SkeletonHome />
  return <HomeContent />
}

function HomeContent(): ReactNode {
  const instances = useAppStore((state) => state.instances)
  const statuses = useAppStore((state) => state.statuses)
  const select = useAppStore((state) => state.select)
  const ensureRecord = useAppStore((state) => state.ensureRecord)

  const connected = instances.filter(
    (item) => toDisplayStatus(statuses[item.id]?.status) === 'connected'
  ).length
  const attention = instances.filter(
    (item) => toDisplayStatus(statuses[item.id]?.status) === 'error'
  ).length
  const sorted = [...instances].sort((a, b) => a.name.localeCompare(b.name, 'zh'))

  const openDetail = (id: string): void => {
    void ensureRecord(id)
    select(id)
  }

  return (
    <section data-od-id="view-home" data-testid="view-home">
      <div className="page-head">
        <p className="eyebrow">INSTANCE OVERVIEW</p>
        <h1>{connected} 个实例已连接</h1>
        <p className="lead">
          本机、SSH 与远程实例都在这里。连接后工作区会嵌在应用内，断线自动重连，远程实例的登录与动态验证码也不用再切浏览器。
        </p>
      </div>
      <div className="grid-3 mt24">
        <StatCard n={instances.length} label="个实例，本地 / SSH / 远程统一入口" />
        <StatCard n={connected} label="个已连接，通道正常" />
        <StatCard n={attention} label="个需要处理，登录或重试" />
      </div>
      <div className="card mt20">
        <div className="card-head">
          <h3>全部实例</h3>
          <span className="meta">状态实时刷新</span>
        </div>
        <table className="ds-table" data-testid="instances-table">
          <thead>
            <tr>
              <th>实例</th>
              <th>类型</th>
              <th>状态</th>
              <th>地址</th>
              <th className="num-col">版本</th>
              <th className="num-col">操作</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <TableRow
                key={item.id}
                item={item}
                statusLabel={STATUS_INFO[toDisplayStatus(statuses[item.id]?.status)].label}
                chipClass={STATUS_INFO[toDisplayStatus(statuses[item.id]?.status)].chipClass}
                version={statuses[item.id]?.version}
                onDetail={() => openDetail(item.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function StatCard(props: { n: number; label: string }): ReactNode {
  return (
    <div className="card stat">
      <div className="stat-num num">{props.n}</div>
      <p className="stat-label">{props.label}</p>
    </div>
  )
}

function TableRow(props: {
  item: InstanceSummary
  statusLabel: string
  chipClass: string
  version?: string
  onDetail: () => void
}): ReactNode {
  return (
    <tr>
      <td>
        <button className="row" onClick={props.onDetail} style={{ gap: 7 }}>
          <span className="status-dot" aria-hidden="true" />
          <span>{props.item.name}</span>
        </button>
      </td>
      <td>
        <span className="badge">
          <Icon name={TYPE_INFO[props.item.transport].icon} size={11} />
          {TYPE_INFO[props.item.transport].label}
        </span>
      </td>
      <td>
        <span className={`chip ${props.chipClass}`}>{props.statusLabel}</span>
      </td>
      <td className="meta">{props.item.address}</td>
      <td className="num-col meta">{props.version ?? '—'}</td>
      <td className="num-col">
        <button className="btn btn-ghost btn-sm" onClick={props.onDetail} data-testid={`detail-${props.item.id}`}>
          查看详情
        </button>
      </td>
    </tr>
  )
}

/** 首载骨架屏(R6):统计卡 + 表格行占位,不出现空白闪烁 */
function SkeletonHome(): ReactNode {
  return (
    <section data-testid="view-home-skeleton" aria-busy="true" aria-label="正在加载实例列表">
      <div className="page-head">
        <div className="skel" style={{ width: 150, height: 13 }} />
        <div className="skel" style={{ width: 260, height: 26, marginTop: 8 }} />
        <div className="skel" style={{ width: '70%', maxWidth: 560, height: 13, marginTop: 10 }} />
      </div>
      <div className="grid-3 mt24 skel-stats">
        {[0, 1, 2].map((i) => (
          <div className="card" key={i}>
            <div className="skel skel-stat-line" />
            <div className="skel" style={{ width: '64%', height: 11 }} />
          </div>
        ))}
      </div>
      <div className="card mt20">
        <div className="card-head">
          <div className="skel" style={{ width: 90, height: 15 }} />
        </div>
        <table className="ds-table">
          <thead>
            <tr>
              {['实例', '类型', '状态', '地址', '版本', '操作'].map((head) => (
                <th key={head}>{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3].map((row) => (
              <tr className="skel-row" key={row}>
                <td>
                  <div className="skel skel-cell" style={{ width: '52%' }} />
                </td>
                <td>
                  <div className="skel skel-cell" style={{ width: 44 }} />
                </td>
                <td>
                  <div className="skel skel-cell" style={{ width: 64 }} />
                </td>
                <td>
                  <div className="skel skel-cell" style={{ width: '68%' }} />
                </td>
                <td>
                  <div className="skel skel-cell" style={{ width: 48 }} />
                </td>
                <td>
                  <div className="skel skel-cell" style={{ width: 56, marginLeft: 'auto' }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}