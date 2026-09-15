import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { tryParseEndpoint } from '@shared/endpoint'
import { Icon } from '../lib/icons'
import { STATUS_INFO, TYPE_INFO, addressOf, fmtDuration, toDisplayStatus } from '../lib/format'
import { useAppStore } from '../store'
import { Modal } from './Modal'
import VaultCard from './VaultCard'
import { showAuthActions } from '../lib/auth-actions'

/**
 * 设计 §7.1 威胁表「S 冒认(远程)」:直连 HTTP 远程实例默认警告「数据面明文」。
 *
 * 协议判定复用 @shared/endpoint 的权威实现(与主进程 endpoint-resolver 同一份):
 * 省略协议的地址会按 http:// 补全,故同样落入告警;不在此处做 `startsWith('http://')`
 * 这类 ad-hoc 字符串判断。解析失败(记录不该出现)按不告警处理,避免误报。
 * 与 Wizard.tsx 内同名判定保持一致(两处都只在 http 方案下提示)。
 */
function isCleartextEndpoint(endpointUrl: string): boolean {
  const parsed = tryParseEndpoint(endpointUrl)
  return parsed.ok && parsed.endpoint.scheme === 'http'
}

/** 实例详情(设计稿 view-detail 基础卡片版;认证/审计/日志随 T7/T6 扩展) */
export default function DetailView(): ReactNode {
  const selection = useAppStore((state) => state.selection)
  const t = useAppStore((state) => state.t)
  const record = useAppStore((state) => (selection ? state.records[selection] : undefined))
  const status = useAppStore((state) => (selection ? state.statuses[selection] : undefined))
  const ensureRecord = useAppStore((state) => state.ensureRecord)
  const select = useAppStore((state) => state.select)
  const refreshList = useAppStore((state) => state.refreshList)
  const toast = useAppStore((state) => state.toast)
  const userDataPath = useAppStore((state) => state.userDataPath)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [nowTick, setNowTick] = useState(0)

  useEffect(() => {
    if (selection) void ensureRecord(selection)
  }, [selection, ensureRecord])

  // 运行时长刷新:运行中每 5s 一跳
  useEffect(() => {
    if (status?.status !== 'running') return
    const timer = setInterval(() => setNowTick((tick) => tick + 1), 5000)
    return () => clearInterval(timer)
  }, [status?.status, nowTick])

  /** T9-3:登出 = 主进程丢弃客户端 + 清该实例分区会话 Cookie(§5.4) */
  const logout = async (): Promise<void> => {
    if (!record) return
    const result = await window.dshHub?.auth.logout(record.id)
    if (result?.ok) toast('ok', t('detail.loggedOut'), t('detail.loggedOutDetail'))
  }

  if (!selection) return null
  if (!record) {
    return (
      <section data-testid="view-detail-missing">
        <p className="meta">{t('detail.missingHint')}</p>
        <button className="btn btn-secondary btn-sm mt12" onClick={() => select(null)}>
          {t('common.backToOverview')}
        </button>
      </section>
    )
  }

  const display = toDisplayStatus(status?.status)
  const info = STATUS_INFO[display]
  const runningSince = status?.status === 'running' ? Date.parse(status.at) : null
  const version =
    status?.version ?? (record.transport === 'local' ? record.dshVersion : null) ?? '—'

  const copyAddress = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(addressOf(record))
      toast('ok', t('detail.addressCopied'))
    } catch {
      toast('err', t('detail.copyFailed'))
    }
  }

  const deleteInstance = async (): Promise<void> => {
    const bridge = window.dshHub
    if (!bridge) return
    const result = await bridge.instances.remove(record.id)
    if (!result.ok) {
      toast('err', t('detail.deleteFailed'), result.message)
      return
    }
    toast('ok', t('detail.deleted', { name: record.name }))
    select(null)
    void refreshList()
  }

  return (
    <section data-od-id="view-detail" data-testid="view-detail">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ gap: 10 }}>
          <span className="brand-mark">
            <Icon name={TYPE_INFO[record.transport].icon} />
          </span>
          <div>
            <div className="row" style={{ gap: 8 }}>
              <h2>{record.name}</h2>
              <span className="badge">
                <Icon name={TYPE_INFO[record.transport].icon} size={11} />
                {t(TYPE_INFO[record.transport].labelKey)}
              </span>
            </div>
            <p className="meta" style={{ marginTop: 3 }}>
              <span className={`chip ${info.chipClass}`}>{t(info.labelKey)}</span>
              {status?.detail ? ` · ${status.detail}` : ''}
            </p>
          </div>
        </div>
        <div className="row">
          <button className="btn btn-ghost btn-sm" onClick={() => select(null)}>
            <Icon name="back" /> {t('detail.overview')}
          </button>
        </div>
      </div>

      <div className="grid-2 mt20">
        <div className="card">
          <div className="card-head">
            <h3>{t('detail.connection')}</h3>
            <span className="meta">{record.transport === 'local'
                  ? t('detail.loopback')
                  : record.transport === 'ssh'
                    ? t('detail.tunnelEncrypted')
                    : t('detail.direct')}</span>
          </div>
          <dl className="kv">
            <dt>{t('detail.address')}</dt>
            <dd className="num">{addressOf(record)}</dd>
            {record.transport === 'ssh' && (
              <>
                <dt>{t('detail.sshPort')}</dt>
                <dd className="num">{record.port}</dd>
                <dt>{t('detail.remotePort')}</dt>
                <dd className="num">{record.remotePort}</dd>
                <dt>{t('detail.tunnel')}</dt>
                <dd className="num">{record.localPort ? `127.0.0.1:${record.localPort}` : t('detail.unassigned')}</dd>
                <dt>{t('detail.identityFile')}</dt>
                <dd className="num">{record.identityFile ?? t('detail.defaultAgentFirst')}</dd>
              </>
            )}
            {record.transport === 'http' && (
              <>
                <dt>{t('detail.authMode')}</dt>
                <dd>
                  {record.authMode === 'none'
                    ? t('detail.authNone')
                    : record.authMode === 'gateway'
                      ? t('detail.authGateway')
                      : t('detail.authAuto')}
                </dd>
              </>
            )}
          </dl>
          {record.transport === 'local' && (
            <div className="note n-warn mt12">
              <Icon name="alert" />
              <span>
                {t('detail.loopbackWarning')}
              </span>
            </div>
          )}
          {/* 设计 §7.1:直连 http:// 远程实例的数据面为明文 —— 常驻警告(https 不告警) */}
          {record.transport === 'http' && isCleartextEndpoint(record.endpointUrl) && (
            <div className="note n-warn mt12" data-testid="cleartext-warning">
              <Icon name="alert" />
              <span>{t('detail.cleartextWarning')}</span>
            </div>
          )}
          <div className="row mt12">
            {showAuthActions(record) && (
              <button
                className="btn btn-primary btn-sm"
                data-testid="login-btn"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('dsh-hub:open-auth', {
                      detail: { id: record.id, name: record.name }
                    })
                  )
                }
              >
                <Icon name="key" /> {t('detail.login')}
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => void copyAddress()}>
              <Icon name="copy" /> {t('detail.address')}
            </button>
            {/* T9-3:登出此前只有 IPC 通道、没有渲染层入口 ——
                导致「登出即清分区会话」这条链路在产品里根本走不到 */}
            {showAuthActions(record) && (
              <button
                className="btn btn-secondary btn-sm"
                data-testid="logout-btn"
                onClick={() => void logout()}
              >
                <Icon name="close" /> {t('detail.logout')}
              </button>
            )}
          </div>
        </div>

        {/* T10 §7.2:凭据存储策略(显式勾选才持久化;降级必须在 UI 告警) */}
        {showAuthActions(record) && (
          <VaultCard key={record.id} instanceId={record.id} />
        )}

        <div className="card">
          <div className="card-head">
            <h3>{t('detail.runInfo')}</h3>
            <span className="meta">{record.transport === 'local' ? t('detail.localSide') : t('detail.remoteSide')}</span>
          </div>
          <dl className="kv">
            <dt>{t('detail.dshVersion')}</dt>
            <dd className="num">{version}</dd>
            <dt>{t('detail.uptime')}</dt>
            <dd className="num">
              {runningSince !== null
                ? fmtDuration(Date.now() - runningSince, t)
                : t('detail.notRunning')}
            </dd>
            {record.transport === 'local' && (
              <>
                <dt>{t('detail.port')}</dt>
                <dd className="num">{record.port ?? t('detail.unassigned')}</dd>
                <dt>{t('settings.dataDir')}</dt>
                <dd className="num" title={t('detail.dataDirTitle')}>
                  {userDataPath ? `${userDataPath}/homes/${record.id}` : `…/homes/${record.id}`}
                </dd>
              </>
            )}
          </dl>
          <div className="row mt12">
            {record.transport === 'local' ||
            record.transport === 'ssh' ||
            record.transport === 'http' ? (
              <>
                {display === 'connected' ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void window.dshHub?.runtime.stop(record.id)}
                    data-testid="stop-btn"
                  >
                    <Icon name="power" /> {t('detail.stop')}
                  </button>
                ) : (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void window.dshHub?.runtime.start(record.id)}
                    disabled={display === 'connecting'}
                    data-testid="start-btn"
                  >
                    {display === 'connecting' ? t('detail.starting') : t('detail.start')}
                  </button>
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    void window.dshHub?.runtime.openView(record.id).then((result) => {
                      if (result && !result.ok) toast('err', t('detail.openViewFailed'), result.message)
                    })
                  }}
                  disabled={display !== 'connected'}
                  data-testid="open-view-btn"
                >
                  <Icon name="external" /> {t('detail.openView')}
                </button>
              </>
            ) : (
              <span className="meta">{t('detail.noRuntimeControl')}</span>
            )}
          </div>
        </div>
      </div>

      <div className="card mt16">
        <div className="card-head">
          <h3>{t('detail.dangerZone')}</h3>
          <span className="meta">{t('detail.irreversible')}</span>
        </div>
        <div className="row-between">
          <p className="meta" style={{ maxWidth: '52ch' }}>
            {t('detail.deleteBody')}
          </p>
          <button
            className="btn btn-sm"
            style={{
              color: 'var(--danger-ink)',
              border: '1px solid color-mix(in oklch, var(--danger) 40%, var(--border))'
            }}
            onClick={() => setConfirmDelete(true)}
            data-testid="delete-btn"
          >
            <Icon name="trash" /> {t('detail.deleteInstance')}
          </button>
        </div>
      </div>

      {confirmDelete && (
        <Modal
      closeLabel={t('common.close')}
          title={t('detail.deleteTitle')}
          onClose={() => setConfirmDelete(false)}
          testId="confirm-delete"
          footer={
            <>
              <span className="meta">{t('detail.deleteCannotUndo')}</span>
              <div className="right">
                <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(false)}>
                 {t('common.cancel')}
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => void deleteInstance()}>
                 {t('detail.delete')}
                </button>
              </div>
            </>
          }
        >
          <p className="meta">
            {t('detail.deleteConfirm', { name: record.name })}
          </p>
        </Modal>
      )}
    </section>
  )
}