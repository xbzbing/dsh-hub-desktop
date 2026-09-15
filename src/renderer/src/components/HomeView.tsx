import type { ReactNode } from 'react'
import type { InstanceSummary } from '@shared/contracts'
import { Icon } from '../lib/icons'
import { STATUS_INFO, TYPE_INFO, toDisplayStatus } from '../lib/format'
import { useAppStore } from '../store'
import type { MessageKey } from '@shared/i18n/messages'

/** 总览页:统计卡 + 全部实例表格(设计稿 view-home,D1 已决表格形态) */
export default function HomeView(): ReactNode {
  const loaded = useAppStore((state) => state.loaded)
  if (!loaded) return <SkeletonHome />
  return <HomeContent />
}

function HomeContent(): ReactNode {
  const t = useAppStore((state) => state.t)
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
        <h1>{t('home.heroTitle', { n: connected })}</h1>
        <p className="lead">
          {t('home.heroBody')}
        </p>
      </div>
      <div className="grid-3 mt24">
        <StatCard n={instances.length} label={t('home.statInstances')} />
        <StatCard n={connected} label={t('home.statConnected')} />
        <StatCard n={attention} label={t('home.statAttention')} />
      </div>
      <div className="card mt20">
        <div className="card-head">
          <h3>{t('home.allInstances')}</h3>
          <span className="meta">{t('home.liveStatus')}</span>
        </div>
        <table className="ds-table" data-testid="instances-table">
          <thead>
            <tr>
              <th>{t('home.colInstance')}</th>
              <th>{t('home.colType')}</th>
              <th>{t('home.colStatus')}</th>
              <th>{t('home.colAddress')}</th>
              <th className="num-col">{t('home.colVersion')}</th>
              <th className="num-col">{t('home.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <TableRow
                key={item.id}
                item={item}
                statusLabel={t(STATUS_INFO[toDisplayStatus(statuses[item.id]?.status)].labelKey)}
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
  const t = useAppStore((state) => state.t)
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
          {t(TYPE_INFO[props.item.transport].labelKey)}
        </span>
      </td>
      <td>
        <span className={`chip ${props.chipClass}`}>{props.statusLabel}</span>
      </td>
      <td className="meta">{props.item.address}</td>
      <td className="num-col meta">{props.version ?? '—'}</td>
      <td className="num-col">
        <button className="btn btn-ghost btn-sm" onClick={props.onDetail} data-testid={`detail-${props.item.id}`}>
          {t('home.viewDetail')}
        </button>
      </td>
    </tr>
  )
}

/** 首载骨架屏(R6):统计卡 + 表格行占位,不出现空白闪烁 */
function SkeletonHome(): ReactNode {
  const t = useAppStore((state) => state.t)
  return (
    <section data-testid="view-home-skeleton" aria-busy="true" aria-label={t('home.loadingList')}>
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
              {[
                'home.colInstance',
                'home.colType',
                'home.colStatus',
                'home.colAddress',
                'home.colVersion',
                'home.colActions'
              ].map((head) => (
                <th key={head}>{t(head as MessageKey)}</th>
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