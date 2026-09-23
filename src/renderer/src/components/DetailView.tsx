import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { tryParseEndpoint } from '@shared/endpoint'
import { Icon } from '../lib/icons'
import { STATUS_INFO, TYPE_INFO, addressOf, toDisplayStatus } from '../lib/format'
import { useAppStore, type ActivityLine } from '../store'
import { Modal } from './Modal'
import EditInstanceDialog from './EditInstanceDialog'
import VaultCard from './VaultCard'
import DshVersionControl from './DshVersionControl'
import { PHASE_KEYS } from '../lib/version-phases'
import { showAuthActions } from '../lib/auth-actions'

/**
 * 直连 HTTP 远程实例使用明文数据连接，需要显示警告。
 * 协议判定复用共享端点解析；解析失败时不显示警告以避免误报。
 */
function isCleartextEndpoint(endpointUrl: string): boolean {
  const parsed = tryParseEndpoint(endpointUrl)
  return parsed.ok && parsed.endpoint.scheme === 'http'
}

/** 实例详情。 */
export default function DetailView(): ReactNode {
  const selection = useAppStore((state) => state.selection)
  const t = useAppStore((state) => state.t)
  const record = useAppStore((state) => (selection ? state.records[selection] : undefined))
  const status = useAppStore((state) => (selection ? state.statuses[selection] : undefined))
  const workspaceConnected = useAppStore((state) =>
    selection ? state.workspaceConnected[selection] ?? true : true
  )
  const authPhase = useAppStore((state) => (selection ? state.authPhases[selection] : undefined))
  const ensureRecord = useAppStore((state) => state.ensureRecord)
  const select = useAppStore((state) => state.select)
  const refreshList = useAppStore((state) => state.refreshList)
  const disconnectWorkspace = useAppStore((state) => state.disconnectWorkspace)
  const toast = useAppStore((state) => state.toast)
  const openWorkspace = useAppStore((state) => state.openWorkspace)
  const setPendingOpen = useAppStore((state) => state.setPendingOpen)
  const localHome = useAppStore((state) =>
    selection ? state.instances.find((instance) => instance.id === selection)?.localHome : undefined
  )
  const activity = useAppStore((state) => (selection ? state.activityLog[selection] : undefined))
  const clearActivity = useAppStore((state) => state.clearActivity)
  const logBodyRef = useRef<HTMLDivElement | null>(null)
  const logMoreRef = useRef<HTMLDivElement | null>(null)
  const [showLogMore, setShowLogMore] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [trashSpace, setTrashSpace] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  /** 检测尚未由 Hub 管理的本地 dsh web 进程。 */
  const [externalDsh, setExternalDsh] = useState<
    Array<{ pid: number; port: number | null; patch: string | null; command: string }>
  >([])
  const [adopting, setAdopting] = useState<number | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [externalAccess, setExternalAccess] = useState<Record<number, string>>({})
  const [showExternalTokenEditor, setShowExternalTokenEditor] = useState(false)
  const [externalToken, setExternalToken] = useState('')

  useEffect(() => {
    if (selection) void ensureRecord(selection)
  }, [selection, ensureRecord])

  // 底部信息栏：新行到达后回到行首，保证时间与阶段可见（其余内容可横向滚动）。
  useEffect(() => {
    const element = logBodyRef.current
    if (element) element.scrollLeft = 0
  }, [activity])

  // 「更多」弹层：打开与新行到达时滚到最新。
  useEffect(() => {
    const element = logMoreRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [activity, showLogMore])

  // 认证相位未知时探测一次，使操作按钮反映当前会话状态。
  useEffect(() => {
    if (!selection || !record) return
    if (!showAuthActions(record)) return
    if (authPhase !== undefined) return
    void window.dshHub?.auth.probe(selection)
  }, [selection, record, authPhase])

  // 本机已在运行的 dsh web:仅本地实例且未运行时探测(探测是只读 ps+lsof,便宜)。
  // 注意 `display` 在下方早期 return 之后才声明,这里按 status 直接判定;
  // 用局部常量做依赖,避免把整个 record 对象拖进依赖数组。
  const runningNow = status?.status === 'running'
  const externalRuntime = status?.runtimeSource === 'external'
  const recordId = record?.id
  const recordTransport = record?.transport
  useEffect(() => {
    if (!recordTransport || recordTransport !== 'local' || runningNow) {
      setExternalDsh([])
      return
    }
    let cancelled = false
    void window.dshHub?.runtime.scanExternal().then((result) => {
      if (cancelled) return
      setExternalDsh(result?.ok ? result.value.filter((item) => item.port !== null) : [])
    })
    return () => {
      cancelled = true
    }
  }, [recordId, recordTransport, runningNow])

  /** 登出会清除主进程客户端和该实例分区的会话 Cookie。 */
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

  const display = toDisplayStatus(status?.status, workspaceConnected)
  const info = STATUS_INFO[display]
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

  /** 底部信息栏行格式：时间 + 状态原文；升级进度按阶段措辞，失败与完成单独成句。 */
  const formatActivity = (line: ActivityLine): string => {
    if (line.source === 'runtime') {
      return `${new Date(line.at).toLocaleTimeString()}  ${line.detail}`
    }
    const event = line.event
    const time = new Date(event.at).toLocaleTimeString()
    if (event.phase === 'error') {
      return `${time}  ${t('detail.version.upgradeFailed', {
        msg: event.error ?? t('common.unknown')
      })}`
    }
    const phaseText =
      event.phase === 'done'
        ? `${t(PHASE_KEYS.done)}${event.version ? ` v${event.version}` : ''}`
        : `${t(PHASE_KEYS[event.phase])}${
            event.percent !== undefined ? ` ${Math.round(event.percent)}%` : ''
          }`
    return `${time}  ${phaseText}${event.detail ? `  ${event.detail}` : ''}`
  }

  /** 最新一行日志：信息栏单行展示它，历史在「更多」弹层里看。 */
  const latestLine = activity?.at(-1)

  /** 复制全部日志（时间 + 阶段原文，逐行）。 */
  const copyActivity = async (): Promise<void> => {
    if (activity === undefined || activity.length === 0) return
    try {
      await navigator.clipboard.writeText(activity.map(formatActivity).join('\n'))
      toast('ok', t('detail.log.copied'))
    } catch {
      toast('err', t('detail.copyFailed'))
    }
  }

  const disconnectView = async (): Promise<void> => {
    await disconnectWorkspace(record.id)
  }

  /** 重启 hub 托管的本地 dsh 进程；进程归用户所有的外部接管实例不提供该操作。 */
  const restartRuntime = async (): Promise<void> => {
    if (!record || restarting) return
    // 在调用前捕获连接态：重启内部的停止事件会先于 IPC 返回把它置为 false
    const wasConnected = workspaceConnected
    setRestarting(true)
    try {
      const result = await window.dshHub?.runtime.restart(record.id)
      if (!result?.ok) {
        toast('err', t('detail.restartFailed'), result?.message)
        return
      }
      // 重启可能分配新端口与新 browser-auth URL：工作区开着时置 pendingOpen，
      // 由 running 状态事件自动重开，避免停留在已失效的旧页面。
      if (wasConnected) setPendingOpen(record.id)
    } finally {
      setRestarting(false)
    }
  }

  /** 关闭本地实例：先断开内嵌工作区，再停止运行时；状态由 stopped 事件推进。 */
  const stopRuntime = async (): Promise<void> => {
    if (!record || stopping) return
    setStopping(true)
    try {
      await disconnectWorkspace(record.id)
      const result = await window.dshHub?.runtime.stop(record.id)
      if (!result?.ok) {
        toast('err', t('detail.stopFailed'), result?.message)
        return
      }
      toast('ok', t('detail.stopped'))
    } finally {
      setStopping(false)
    }
  }

  const deleteInstance = async (): Promise<void> => {
    const bridge = window.dshHub
    if (!bridge) return
    const result = await bridge.instances.remove(record.id, { trashSpace })
    if (!result.ok) {
      toast('err', t('detail.deleteFailed'), result.message)
      return
    }
    toast('ok', t('detail.deleted', { name: record.name }))
    setTrashSpace(false)
    select(null)
    void refreshList()
  }

  const updateExternalToken = async (): Promise<void> => {
    const bridge = window.dshHub
    if (!bridge || record.transport !== 'local') return
    const token = externalToken.trim()
    if (token === '') {
      toast('err', t('detail.adoptFailed'), t('wizard.errExternalAccess'))
      return
    }
    const scanned = await bridge.runtime.scanExternal()
    if (!scanned.ok) {
      toast('err', t('detail.adoptFailed'), scanned.message)
      return
    }
    const targetPort = status?.port ?? record.port
    const candidate = scanned.value.find((item) => item.port === targetPort) ?? (scanned.value.length === 1 ? scanned.value[0] : undefined)
    if (!candidate) {
      toast('err', t('detail.adoptFailed'), t('detail.externalTokenBody'))
      return
    }
    setAdopting(candidate.pid)
    const result = await bridge.runtime.adoptExternal(record.id, candidate.pid, token)
    setAdopting(null)
    if (!result.ok) {
      toast('err', t('detail.adoptFailed'), result.message)
      return
    }
    setExternalToken('')
    setShowExternalTokenEditor(false)
    void openWorkspace(record.id)
  }

  return (
    <section className="detail-page" data-od-id="view-detail" data-testid="view-detail">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ gap: 12 }}>
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
            <p className="meta" style={{ marginTop: 4 }}>
              <span className={`chip ${info.chipClass}`}>
                <span className={`status-dot ${info.dotClass}`} aria-hidden="true" />
                {t(info.labelKey)}
              </span>
            </p>
          </div>
        </div>
        <div className="row">
          <button
            className="btn btn-ghost btn-sm detail-overview-btn"
            onClick={() => select(null)}
            data-testid="detail-overview-btn"
          >
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
          {/* 直连 HTTP 使用明文数据连接，显示可访问的常驻警告。 */}
          {record.transport === 'http' && isCleartextEndpoint(record.endpointUrl) && (
            <span
              className="warn-pill"
              data-testid="cleartext-warning"
              data-tip={t('detail.cleartextWarning')}
              aria-label={t('detail.cleartextWarning')}
              tabIndex={0}
            >
              <Icon name="alert" />
              <span>{t('detail.cleartextBadge')}</span>
            </span>
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
                <Icon name="key" />{' '}
                {/* 已连接时显示“重新登录”，否则显示“登录”。 */}
                {authPhase === 'connected' ? t('detail.relogin') : t('detail.login')}
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => void copyAddress()}>
              <Icon name="copy" /> {t('detail.address')}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              data-testid="disconnect-view-btn"
              onClick={() => void disconnectView()}
            >
              <Icon name="close" /> {t('detail.disconnect')}
            </button>
            {/* 仅在已连接时显示登出操作。 */}
            {showAuthActions(record) && authPhase === 'connected' && (
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

        {/* 凭据默认持久化，用户可在实例详情中显式取消。 */}
        {showAuthActions(record) && (
          <VaultCard key={record.id} instanceId={record.id} />
        )}

        <div className="card runtime-card">
          <div className="card-head">
            <h3>{t('detail.runtime')}</h3>
            <span className="meta">{record.transport === 'local' ? t('detail.localSide') : t('detail.remoteSide')}</span>
          </div>
          <dl className="kv">
            <dt>{t('detail.dshVersion')}</dt>
            <dd className="num">{version}</dd>
            {record.transport === 'local' && (
              <>
                <dt>{t('detail.port')}</dt>
                {/* 已接管进程的运行端口优先使用状态事件中的端口。 */}
                <dd className="num">{status?.port ?? record.port ?? t('detail.unassigned')}</dd>
                <dt>{t('settings.dataDir')}</dt>
                <dd className="num" title={t('detail.dataDirTitle')}>
                  {status?.runtimeSource === 'external'
                    ? t('detail.externalDataDir')
                    : (localHome ?? `…/homes/${record.id}`)}
                </dd>
              </>
            )}
          </dl>
          {/* dsh 版本管理仅本机实例：检查更新对比的是本机 npm 镜像，远程实例版本 hub 无从得知也不受 hub 管。 */}
          {record.transport === 'local' && <DshVersionControl instanceId={record.id} />}
          <div className="row mt12 runtime-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                if (record.transport === 'local') {
                  if (status?.status === 'running') {
                    void openWorkspace(record.id)
                    return
                  }
                  setPendingOpen(record.id)
                  void window.dshHub?.runtime.start(record.id).then((result) => {
                    if (!result?.ok) toast('err', t('detail.startFailed'), result?.message)
                  })
                  return
                }
                void openWorkspace(record.id)
              }}
              disabled={display === 'connecting'}
              data-testid="open-view-btn"
            >
              <Icon name="external" />
              {display === 'connecting'
                ? t('detail.openingWorkspace')
                : status?.status === 'running'
                  ? t('detail.openWorkspace')
                  : t('detail.startWorkspace')}
            </button>
            {/* 重启只针对 hub 拉起的运行中进程；外部接管的进程归用户所有。 */}
            {record.transport === 'local' && status?.status === 'running' && status.runtimeSource !== 'external' && (
              <button
                className="btn btn-danger btn-sm"
                onClick={() => void restartRuntime()}
                disabled={restarting}
                data-testid="restart-btn"
              >
                <Icon name="refresh" /> {restarting ? t('detail.restarting') : t('detail.restart')}
              </button>
            )}
            {/* 关闭实例：断开工作区并停止 hub 托管的运行中进程；外部接管进程归用户所有，不提供。 */}
            {record.transport === 'local' && status?.status === 'running' && status.runtimeSource !== 'external' && (
              <button
                className="btn btn-danger btn-sm"
                onClick={() => void stopRuntime()}
                disabled={stopping}
                data-testid="stop-btn"
              >
                <Icon name="power" /> {stopping ? t('detail.stopping') : t('detail.stop')}
              </button>
            )}
            {/* transport 不可修改；端口留空时自动分配，运行中修改在下次启动生效。 */}
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowEdit(true)}
              data-testid="edit-btn"
            >
              <Icon name="edit" /> {t('edit.openButton')}
            </button>
          </div>
        </div>

        {record.transport === 'local' && (externalRuntime || showExternalTokenEditor) && (
          <div className="card mt12" data-testid="external-token-editor">
            <div className="card-head">
              <h3>{t('detail.externalTokenTitle')}</h3>
            </div>
            <p className="meta" style={{ marginBottom: 10 }}>
              {t('detail.externalTokenBody')}
            </p>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: 1 }}>
                <span>{t('wizard.externalAccessLabel')}</span>
                <input
                  className="input num"
                  value={externalToken}
                  onChange={(event) => setExternalToken(event.target.value)}
                  autoComplete="off"
                  type="password"
                  data-testid="external-token-input"
                />
              </label>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void updateExternalToken()}
                disabled={adopting !== null}
                data-testid="external-token-update-btn"
              >
                <Icon name="external" />
                {adopting !== null ? t('detail.externalTokenUpdating') : t('detail.externalTokenUpdate')}
              </button>
            </div>
          </div>
        )}

        {/* 显示尚未由 Hub 管理的本地 dsh web 进程，供用户接管。 */}
        {record.transport === 'local' && externalDsh.length > 0 && (
          <div className="card" data-testid="external-dsh-card">
            <div className="card-head">
              <h3>{t('detail.externalTitle')}</h3>
              <span className="meta">{t('detail.externalCount', { n: externalDsh.length })}</span>
            </div>
            <p className="meta" style={{ marginBottom: 10 }}>
              {t('detail.externalBody')}
            </p>
            {externalDsh.map((item) => (
              <div key={item.pid} className="row-between ext-row">
                <div style={{ minWidth: 0 }}>
                  <div className="num" style={{ fontSize: 12.5 }}>
                    127.0.0.1:{item.port} <span className="meta">· pid {item.pid}</span>
                  </div>
                  <div
                    className="meta"
                    style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={item.command}
                  >
                    {item.patch
                      ? `${t('detail.externalPatch')} ${item.patch}`
                      : t('detail.externalNoPatch')}
                  </div>
                  <input
                    className="input num mt8"
                    value={externalAccess[item.pid] ?? ''}
                    onChange={(event) =>
                      setExternalAccess((current) => ({ ...current, [item.pid]: event.target.value }))
                    }
                    autoComplete="off"
                    type="password"
                    aria-label={t('wizard.externalAccessLabel')}
                    data-testid={`external-access-${item.pid}`}
                  />
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  data-testid={`adopt-btn-${item.pid}`}
                  disabled={adopting !== null}
                  onClick={() => {
                    setAdopting(item.pid)
                    void window.dshHub?.runtime
                      .adoptExternal(record.id, item.pid, externalAccess[item.pid] ?? '')
                      .then((result) => {
                        if (result && !result.ok) {
                          toast('err', t('detail.adoptFailed'), result.message)
                        } else {
                          toast('ok', t('detail.adopted'), `127.0.0.1:${item.port}`)
                          void openWorkspace(record.id)
                        }
                      })
                      .finally(() => setAdopting(null))
                  }}
                >
                  <Icon name="external" /> {adopting === item.pid ? t('detail.adopting') : t('detail.adopt')}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部信息栏：固定在详情页最底部，单行展示最新日志（可横向滚动），右侧「更多」查看历史。 */}
      <div className="detail-logbar" data-testid="detail-logbar">
        <div className="detail-logbar__body" ref={logBodyRef} data-testid="detail-logbar-body">
          <p className="detail-logbar__line num">
            {latestLine !== undefined ? formatActivity(latestLine) : t('detail.log.empty')}
          </p>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowLogMore(true)}
          data-testid="detail-logbar-more"
        >
          {t('detail.log.more')}
        </button>
      </div>

      <div className="detail-delete" data-testid="detail-delete-area">
        <span className="meta">{t('detail.deleteBody')}</span>
        <button
          className="detail-delete-btn"
          onClick={() => setConfirmDelete(true)}
          data-testid="delete-btn"
          aria-label={t('detail.deleteInstance')}
        >
          <Icon name="trash" />
          <span>{t('detail.deleteInstance')}</span>
        </button>
      </div>

      {showLogMore && (
        <Modal
          wide
          closeLabel={t('common.close')}
          title={t('detail.log.title')}
          onClose={() => setShowLogMore(false)}
          testId="log-more"
          initialFocus="dialog"
          closeButtonInTabOrder={false}
          footer={
            <div className="right">
              {latestLine !== undefined && (
                <>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void copyActivity()}
                    data-testid="log-more-copy"
                  >
                    {t('detail.log.copy')}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => clearActivity(record.id)}
                    data-testid="log-more-clear"
                  >
                    {t('detail.log.clear')}
                  </button>
                </>
              )}
            </div>
          }
        >
          <div className="detail-logmore" ref={logMoreRef} data-testid="log-more-body">
            {activity === undefined || activity.length === 0 ? (
              <p className="meta">{t('detail.log.empty')}</p>
            ) : (
              activity.map((line, index) => (
                <p className="detail-logmore__line num" key={index}>
                  {formatActivity(line)}
                </p>
              ))
            )}
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal
      closeLabel={t('common.close')}
          title={t('detail.deleteTitle')}
          onClose={() => { setConfirmDelete(false); setTrashSpace(false) }}
          testId="confirm-delete"
          footer={
            <>
              <span className="meta">{t('detail.deleteCannotUndo')}</span>
              <div className="right">
                <button className="btn btn-secondary btn-sm" onClick={() => { setConfirmDelete(false); setTrashSpace(false) }}>
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
          {record.transport === 'local' && !record.useDefaultSpace && (
            <label className="check mt12">
              <input type="checkbox" checked={trashSpace} onChange={(event) => setTrashSpace(event.target.checked)} />
              {t('detail.deleteSpace')}
            </label>
          )}
        </Modal>
      )}

      {showEdit && (
        <EditInstanceDialog
          record={record}
          running={status?.status === 'running'}
          onClose={() => setShowEdit(false)}
        />
      )}
    </section>
  )
}