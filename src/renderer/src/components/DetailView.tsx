import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../lib/icons'
import { STATUS_INFO, TYPE_INFO, addressOf, fmtDuration, toDisplayStatus } from '../lib/format'
import { useAppStore } from '../store'
import { Modal } from './Modal'
import VaultCard from './VaultCard'

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
    if (result?.ok) toast('ok', '已登出', '该实例的分区会话已清除')
  }

  if (!selection) return null
  if (!record) {
    return (
      <section data-testid="view-detail-missing">
        <p className="meta">实例不存在或已被删除。</p>
        <button className="btn btn-secondary btn-sm mt12" onClick={() => select(null)}>
          回到总览
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
      toast('ok', '地址已复制')
    } catch {
      toast('err', '复制失败')
    }
  }

  const deleteInstance = async (): Promise<void> => {
    const bridge = window.dshHub
    if (!bridge) return
    const result = await bridge.instances.remove(record.id)
    if (!result.ok) {
      toast('err', '删除失败', result.message)
      return
    }
    toast('ok', `「${record.name}」已删除`)
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
            <Icon name="back" /> 总览
          </button>
        </div>
      </div>

      <div className="grid-2 mt20">
        <div className="card">
          <div className="card-head">
            <h3>连接方式</h3>
            <span className="meta">{record.transport === 'local' ? '本机回环' : record.transport === 'ssh' ? '加密隧道' : '直连'}</span>
          </div>
          <dl className="kv">
            <dt>地址</dt>
            <dd className="num">{addressOf(record)}</dd>
            {record.transport === 'ssh' && (
              <>
                <dt>SSH 端口</dt>
                <dd className="num">{record.port}</dd>
                <dt>远端端口</dt>
                <dd className="num">{record.remotePort}</dd>
                <dt>隧道</dt>
                <dd className="num">{record.localPort ? `127.0.0.1:${record.localPort}` : '未分配'}</dd>
                <dt>使用密钥</dt>
                <dd className="num">{record.identityFile ?? '默认（agent 优先）'}</dd>
              </>
            )}
            {record.transport === 'http' && (
              <>
                <dt>认证</dt>
                <dd>
                  {record.authMode === 'none'
                    ? '无需登录'
                    : record.authMode === 'gateway'
                      ? '网关登录（密码 + 动态验证码）'
                      : '自动探测（连接后识别；登录面板在 T8 提供）'}
                </dd>
              </>
            )}
          </dl>
          {record.transport === 'local' && (
            <div className="note n-warn mt12">
              <Icon name="alert" />
              <span>
                本机回环连接未加密。仅本机可访问，不会经过网络；实例页面由 dsh 自带的浏览器令牌保护（browser-auth，T6 细化）。
              </span>
            </div>
          )}
          <div className="row mt12">
            {record.transport !== 'local' && record.authMode !== 'none' && (
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
                <Icon name="key" /> 登录 / 重新登录
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => void copyAddress()}>
              <Icon name="copy" /> 复制地址
            </button>
            {/* T9-3:登出此前只有 IPC 通道、没有渲染层入口 ——
                导致「登出即清分区会话」这条链路在产品里根本走不到 */}
            {record.transport !== 'local' && record.authMode !== 'none' && (
              <button
                className="btn btn-secondary btn-sm"
                data-testid="logout-btn"
                onClick={() => void logout()}
              >
                <Icon name="close" /> 登出
              </button>
            )}
          </div>
        </div>

        {/* T10 §7.2:凭据存储策略(显式勾选才持久化;降级必须在 UI 告警) */}
        {record.transport !== 'local' && record.authMode !== 'none' && (
          <VaultCard key={record.id} instanceId={record.id} />
        )}

        <div className="card">
          <div className="card-head">
            <h3>运行信息</h3>
            <span className="meta">{record.transport === 'local' ? '本机' : '远端'}</span>
          </div>
          <dl className="kv">
            <dt>dsh 版本</dt>
            <dd className="num">{version}</dd>
            <dt>运行时长</dt>
            <dd className="num">
              {runningSince !== null
                ? fmtDuration(Date.now() - runningSince, t)
                : t('detail.notRunning')}
            </dd>
            {record.transport === 'local' && (
              <>
                <dt>端口</dt>
                <dd className="num">{record.port ?? '未分配'}</dd>
                <dt>数据目录</dt>
                <dd className="num" title="该实例隔离的 DSH_HOME（评审结论 R7）">
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
                    <Icon name="power" /> 停止
                  </button>
                ) : (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void window.dshHub?.runtime.start(record.id)}
                    disabled={display === 'connecting'}
                    data-testid="start-btn"
                  >
                    {display === 'connecting' ? '启动中…' : '启动'}
                  </button>
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    void window.dshHub?.runtime.openView(record.id).then((result) => {
                      if (result && !result.ok) toast('err', '打开视图失败', result.message)
                    })
                  }}
                  disabled={display !== 'connected'}
                  data-testid="open-view-btn"
                >
                  <Icon name="external" /> 打开视图
                </button>
              </>
            ) : (
              <span className="meta">该传输类型暂不支持运行时控制</span>
            )}
          </div>
        </div>
      </div>

      <div className="card mt16">
        <div className="card-head">
          <h3>危险操作</h3>
          <span className="meta">不可撤销</span>
        </div>
        <div className="row-between">
          <p className="meta" style={{ maxWidth: '52ch' }}>
            删除后本地保存的登录信息与连接记录会一并移除，远端 dsh 本身不受影响。
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
            <Icon name="trash" /> 删除实例
          </button>
        </div>
      </div>

      {confirmDelete && (
        <Modal
          title="删除实例"
          onClose={() => setConfirmDelete(false)}
          testId="confirm-delete"
          footer={
            <>
              <span className="meta">此操作不可撤销</span>
              <div className="right">
                <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(false)}>
                  取消
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => void deleteInstance()}>
                  删除
                </button>
              </div>
            </>
          }
        >
          <p className="meta">
            确定删除「{record.name}」吗？如果是运行中的实例，会先停止其进程。
          </p>
        </Modal>
      )}
    </section>
  )
}