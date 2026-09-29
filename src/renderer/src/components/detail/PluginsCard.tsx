import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PluginInfo } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import { fmtLogTime } from '../../lib/format'
import { Modal } from '../Modal'
import { useAppStore } from '../../store'
import {
  canOfferUpgrade,
  initialCheckState,
  pluginKindKey,
  pluginSourceKey,
  pruneChecks,
  showsIncompatibleWarning,
  showsUpToDate,
  type PluginCheckState
} from '../../lib/plugins-card-state'
import InstallPluginDialog from './InstallPluginDialog'

const BRIDGE = window.dshHub

/** 一行插件的可变操作态：检查/升级/卸载进行中标记。 */
interface RowBusy {
  upgrading: boolean
  removing: boolean
}

/** 卸载二次确认目标。 */
interface RemoveTarget {
  name: string
  hasHostSide: boolean
}

/** 重启提醒目标（改动含 host 半后弹出）。 */
interface RestartPrompt {
  name: string
}

/** 实例详情的插件管理卡：列表 + 手风琴详情 + 检查升级/卸载/安装 + host 半重启提醒。 */
export default function PluginsCard(props: { t: Translator; instanceId: string }): ReactNode {
  const { t, instanceId } = props
  const toast = useAppStore((state) => state.toast)
  const language = useAppStore((state) => state.language)
  const setPendingOpen = useAppStore((state) => state.setPendingOpen)
  const appendActivity = useAppStore((state) => state.appendActivity)
  const workspaceConnected = useAppStore(
    (state) => state.workspaceConnected[instanceId] ?? false
  )

  /** 把一条插件操作日志写入实例底部信息栏（与运行时状态同一时间线）。 */
  const logActivity = useCallback(
    (detail: string): void => {
      appendActivity(instanceId, { source: 'runtime', at: new Date().toISOString(), detail })
    },
    [appendActivity, instanceId]
  )

  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, PluginCheckState>>({})
  const [busy, setBusy] = useState<Record<string, RowBusy>>({})
  const [showInstall, setShowInstall] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null)
  const [restartPrompt, setRestartPrompt] = useState<RestartPrompt | null>(null)
  /** 上次「检查更新」完成时刻（对整卡的批量或单条检查都刷新）；null = 本会话尚未检查。 */
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)

  /**
   * 拉取插件列表。keepChecks=true 时保留已有检查结果（只按最新列表剪除已卸载插件的项），
   * 用于安装/升级/卸载后刷新列表而不丢失其它插件的检查状态；缺省（初次加载 / 手动刷新）清空。
   */
  const load = useCallback(
    async (options?: { keepChecks?: boolean }): Promise<void> => {
      if (!BRIDGE) return
      setLoading(true)
      setLoadError(null)
      const result = await BRIDGE.plugin.list(instanceId, language)
      setLoading(false)
      if (result.ok) {
        setPlugins(result.value)
        if (options?.keepChecks) {
          const names = result.value.map((plugin) => plugin.name)
          setChecks((prev) => pruneChecks(prev, names))
        } else {
          setChecks({})
        }
      } else {
        setLoadError(result.message)
        setPlugins([])
      }
    },
    [instanceId, language]
  )

  useEffect(() => {
    void load()
  }, [load])

  const rowBusy = (name: string): RowBusy => busy[name] ?? { upgrading: false, removing: false }
  const setRowBusy = (name: string, patch: Partial<RowBusy>): void =>
    setBusy((prev) => ({ ...prev, [name]: { ...rowBusy(name), ...patch } }))

  const checkOf = (name: string): PluginCheckState => checks[name] ?? initialCheckState

  /** 检查单个插件；返回是否成功（供批量检查汇总）。 */
  const runCheck = async (name: string): Promise<void> => {
    if (!BRIDGE) return
    setChecks((prev) => ({ ...prev, [name]: { status: 'checking', result: null, error: null } }))
    const result = await BRIDGE.plugin.check(instanceId, name)
    if (result.ok) {
      setChecks((prev) => ({ ...prev, [name]: { status: 'done', result: result.value, error: null } }))
    } else {
      setChecks((prev) => ({ ...prev, [name]: { status: 'error', result: null, error: result.message } }))
    }
    setLastCheckedAt(new Date().toISOString())
  }

  /** 一键批量检查所有插件更新（串行，避免 registry 限流）。 */
  const runCheckAll = async (): Promise<void> => {
    if (!BRIDGE || plugins === null || checkingAll) return
    setCheckingAll(true)
    try {
      for (const plugin of plugins) {
        setChecks((prev) => ({ ...prev, [plugin.name]: { status: 'checking', result: null, error: null } }))
        const result = await BRIDGE.plugin.check(instanceId, plugin.name)
        setChecks((prev) => ({
          ...prev,
          [plugin.name]: result.ok
            ? { status: 'done', result: result.value, error: null }
            : { status: 'error', result: null, error: result.message }
        }))
      }
      setLastCheckedAt(new Date().toISOString())
    } finally {
      setCheckingAll(false)
    }
  }

  /** 改动含 host 半时提示重启；否则提示刷新页面即可（两者都写入实例日志）。 */
  const afterMutation = (name: string, hasHostSide: boolean): void => {
    if (hasHostSide) {
      logActivity(t('detail.plugin.log.restartHint', { name }))
      setRestartPrompt({ name })
    } else {
      logActivity(t('detail.plugin.log.clientHint', { name }))
      toast('ok', t('detail.plugin.installed'), t('detail.plugin.clientOnlyHint'))
    }
  }

  const runUpgrade = async (name: string, version: string): Promise<void> => {
    if (!BRIDGE) return
    setRowBusy(name, { upgrading: true })
    logActivity(t('detail.plugin.log.upgrading', { name, version }))
    const result = await BRIDGE.plugin.upgrade(instanceId, name, version)
    setRowBusy(name, { upgrading: false })
    if (!result.ok) {
      logActivity(t('detail.plugin.log.upgradeFailed', { name, msg: result.message }))
      toast('err', t('detail.plugin.upgradeFailed', { msg: result.message }))
      return
    }
    logActivity(t('detail.plugin.log.upgraded', { name, version }))
    // 升级后该插件版本已变，自身旧检查结果失效——清掉它，其它插件的检查状态保留。
    setChecks((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    await load({ keepChecks: true })
    afterMutation(name, result.value.hasHostSide)
  }

  const confirmRemove = async (): Promise<void> => {
    if (!BRIDGE || !removeTarget) return
    const { name } = removeTarget
    setRemoveTarget(null)
    setRowBusy(name, { removing: true })
    logActivity(t('detail.plugin.log.removing', { name }))
    const result = await BRIDGE.plugin.remove(instanceId, name)
    setRowBusy(name, { removing: false })
    if (!result.ok) {
      logActivity(t('detail.plugin.log.removeFailed', { name, msg: result.message }))
      toast('err', t('detail.plugin.removeFailed', { msg: result.message }))
      return
    }
    logActivity(t('detail.plugin.log.removed', { name }))
    await load({ keepChecks: true })
    afterMutation(name, result.value.hasHostSide)
  }

  const submitInstall = async (spec: string): Promise<void> => {
    if (!BRIDGE) return
    logActivity(t('detail.plugin.log.installing', { spec }))
    const result = await BRIDGE.plugin.install(instanceId, spec)
    if (!result.ok) {
      logActivity(t('detail.plugin.log.installFailed', { spec, msg: result.message }))
      toast('err', t('detail.plugin.installFailed', { msg: result.message }))
      return
    }
    logActivity(t('detail.plugin.log.installed', { spec }))
    setShowInstall(false)
    await load({ keepChecks: true })
    afterMutation(spec, result.value.hasHostSide)
  }

  const confirmRestart = (): void => {
    if (!restartPrompt || !BRIDGE) return
    setRestartPrompt(null)
    // 重启期间工作区开着则置 pendingOpen，由 running 状态事件自动重开（与详情页重启同路径）。
    if (workspaceConnected) setPendingOpen(instanceId)
    void BRIDGE.runtime.restart(instanceId).then((result) => {
      if (!result.ok) toast('err', t('detail.restartFailed'), result.message)
    })
  }

  const openLink = (url: string | null): void => {
    if (!url || !BRIDGE) return
    void BRIDGE.plugin.openExternal(url).then((result) => {
      if (!result.ok) toast('err', t('detail.plugin.openLinkFailed'), result.message)
    })
  }

  return (
    <div className="card plugins-card selectable" data-testid="plugins-card">
      <div className="card-head">
        <h3>{t('detail.plugin.title')}</h3>
        <div className="row" style={{ gap: 8 }}>
          {/* 上次检查更新时刻：本会话内任一检查（单条或批量）完成即刷新，紧邻刷新按钮左侧。 */}
          {lastCheckedAt !== null && (
            <span className="meta plugin-last-checked" data-testid="plugins-last-checked">
              {t('detail.plugin.lastChecked', { time: fmtLogTime(lastCheckedAt) })}
            </span>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void load()}
            disabled={loading}
            data-testid="plugins-refresh-btn"
          >
            <Icon name="refresh" /> {t('detail.plugin.refresh')}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void runCheckAll()}
            disabled={checkingAll || plugins === null || plugins.length === 0}
            data-testid="plugins-check-all-btn"
          >
            <Icon name="sync" />
            {checkingAll ? t('detail.plugin.checkingAll') : t('detail.plugin.checkAll')}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowInstall(true)}
            data-testid="plugins-install-btn"
          >
            <Icon name="plus" /> {t('detail.plugin.install')}
          </button>
        </div>
      </div>

      {loadError !== null && (
        <p className="meta err-text" data-testid="plugins-load-error">
          {t('detail.plugin.loadFailed', { msg: loadError })}
        </p>
      )}

      {loadError === null && loading && plugins === null && (
        <p className="meta">{t('detail.plugin.loading')}</p>
      )}

      {loadError === null && plugins !== null && plugins.length === 0 && (
        <p className="meta" data-testid="plugins-empty">
          {t('detail.plugin.empty')}
        </p>
      )}

      {plugins !== null && plugins.length > 0 && (
        <ul className="plugin-list" data-testid="plugin-list">
          {plugins.map((plugin) => (
            <PluginRow
              key={plugin.name}
              t={t}
              plugin={plugin}
              expanded={expanded === plugin.name}
              onToggle={() => setExpanded((prev) => (prev === plugin.name ? null : plugin.name))}
              check={checkOf(plugin.name)}
              busy={rowBusy(plugin.name)}
              onCheck={() => void runCheck(plugin.name)}
              onUpgrade={(version) => void runUpgrade(plugin.name, version)}
              onRemove={() => setRemoveTarget({ name: plugin.name, hasHostSide: plugin.hasHostSide })}
              onOpenLink={openLink}
            />
          ))}
        </ul>
      )}

      {showInstall && (
        <InstallPluginDialog t={t} onClose={() => setShowInstall(false)} onSubmit={submitInstall} />
      )}

      {removeTarget !== null && (
        <RemovePluginModal
          t={t}
          target={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onConfirm={() => void confirmRemove()}
        />
      )}

      {restartPrompt !== null && (
        <RestartPromptModal
          t={t}
          name={restartPrompt.name}
          onClose={() => setRestartPrompt(null)}
          onConfirm={confirmRestart}
        />
      )}
    </div>
  )
}

/** 单个插件行：图标 + 名称/版本/来源 + 操作列 + 手风琴详情。 */
function PluginRow(props: {
  t: Translator
  plugin: PluginInfo
  expanded: boolean
  onToggle: () => void
  check: PluginCheckState
  busy: RowBusy
  onCheck: () => void
  onUpgrade: (version: string) => void
  onRemove: () => void
  onOpenLink: (url: string | null) => void
}): ReactNode {
  const { t, plugin, expanded, onToggle, check, busy, onCheck, onUpgrade, onRemove, onOpenLink } = props
  return (
    <li className="plugin-row" data-testid={`plugin-row-${plugin.name}`}>
      <div className="plugin-row-head">
        <button
          className="plugin-expand"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={plugin.name}
          data-testid={`plugin-expand-${plugin.name}`}
        >
          {plugin.iconDataUri ? (
            <img className="plugin-icon" src={plugin.iconDataUri} alt="" width={20} height={20} />
          ) : (
            <span className="plugin-icon plugin-icon-fallback" aria-hidden="true">
              <Icon name="hub" size={16} />
            </span>
          )}
          {/* 有本地化名称则名称为主、包名作二级标题跟随；无名称则包名作主标题。 */}
          <span className="plugin-title-group">
            <span className="plugin-name">{plugin.title ?? plugin.name}</span>
            {plugin.title && <span className="plugin-pkgname num">{plugin.name}</span>}
          </span>
          <span className="badge num">{plugin.version}</span>
          <span className="plugin-source">{t(pluginSourceKey(plugin.installSource))}</span>
        </button>
        <div className="row plugin-actions" style={{ gap: 8 }}>
          {/* 检查结果内联在操作行最左，不换行占整行：已最新 / 不兼容警告 / 检查失败。 */}
          {showsUpToDate(check) && (
            <span className="meta plugin-status-inline" data-testid={`plugin-uptodate-${plugin.name}`}>
              {t('detail.plugin.uptodate')}
            </span>
          )}
          {showsIncompatibleWarning(check) && check.result !== null && (
            <span
              className="meta err-text plugin-status-inline"
              title={t('detail.plugin.incompatible', {
                latest: check.result.latest,
                peer: check.result.dshPeer ?? '—',
                current: check.result.dshVersion ?? '—'
              })}
              data-testid={`plugin-incompatible-${plugin.name}`}
            >
              {t('detail.plugin.incompatible', {
                latest: check.result.latest,
                peer: check.result.dshPeer ?? '—',
                current: check.result.dshVersion ?? '—'
              })}
            </span>
          )}
          {check.status === 'error' && check.error !== null && (
            <span
              className="meta err-text plugin-status-inline"
              title={t('detail.plugin.checkFailed', { msg: check.error })}
              data-testid={`plugin-check-error-${plugin.name}`}
            >
              {t('detail.plugin.checkFailed', { msg: check.error })}
            </span>
          )}
          {plugin.githubUrl && (
            <button
              className="btn btn-ghost btn-sm btn-icon plugin-link"
              onClick={() => onOpenLink(plugin.githubUrl)}
              aria-label={t('detail.plugin.field.github')}
              title={t('detail.plugin.field.github')}
              data-testid={`plugin-github-${plugin.name}`}
            >
              <Icon name="github" />
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm plugin-check-btn"
            onClick={onCheck}
            disabled={check.status === 'checking'}
            data-testid={`plugin-check-${plugin.name}`}
          >
            <Icon name="sync" />
            {/* 两个候选文案叠放在同一 grid 单元，宽度取最大值：切「检查中…/检查升级」按钮不跳动，
                中英文各自按各自的最长文案自适应。 */}
            <span className="btn-swap">
              <span className="btn-swap-cell" data-active={check.status !== 'checking'}>
                {t('detail.plugin.checkUpdate')}
              </span>
              <span className="btn-swap-cell" data-active={check.status === 'checking'}>
                {t('detail.plugin.checking')}
              </span>
            </span>
          </button>
          {canOfferUpgrade(check) && check.result !== null && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onUpgrade(check.result!.latest)}
              disabled={busy.upgrading}
              data-testid={`plugin-upgrade-${plugin.name}`}
            >
              <Icon name="refresh" />
              {busy.upgrading
                ? t('detail.plugin.upgrading')
                : t('detail.plugin.upgradeTo', { version: check.result.latest })}
            </button>
          )}
          <button
            className="btn btn-danger btn-sm btn-icon plugin-remove-btn"
            onClick={onRemove}
            disabled={busy.removing}
            aria-label={t('detail.plugin.remove')}
            title={busy.removing ? t('detail.plugin.removing') : t('detail.plugin.remove')}
            data-testid={`plugin-remove-${plugin.name}`}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      {expanded && (
        <PluginDetail t={t} plugin={plugin} check={check} onOpenLink={onOpenLink} />
      )}
    </li>
  )
}

/** 手风琴展开的插件详情。 */
function PluginDetail(props: {
  t: Translator
  plugin: PluginInfo
  check: PluginCheckState
  onOpenLink: (url: string | null) => void
}): ReactNode {
  const { t, plugin, check, onOpenLink } = props
  const modified = check.result?.modifiedAt ?? null
  return (
    <dl className="kv plugin-detail" data-testid={`plugin-detail-${plugin.name}`}>
      {plugin.description && (
        <>
          <dt>{t('detail.plugin.field.description')}</dt>
          <dd>{plugin.description}</dd>
        </>
      )}
      {plugin.author && (
        <>
          <dt>{t('detail.plugin.field.author')}</dt>
          <dd>{plugin.author}</dd>
        </>
      )}
      {plugin.license && (
        <>
          <dt>{t('detail.plugin.field.license')}</dt>
          <dd>{plugin.license}</dd>
        </>
      )}
      {plugin.githubUrl && (
        <>
          <dt>{t('detail.plugin.field.github')}</dt>
          <dd>
            <button className="link-btn" onClick={() => onOpenLink(plugin.githubUrl)}>
              {plugin.githubUrl}
            </button>
          </dd>
        </>
      )}
      {plugin.npmUrl && (
        <>
          <dt>{t('detail.plugin.field.npm')}</dt>
          <dd>
            <button className="link-btn" onClick={() => onOpenLink(plugin.npmUrl)}>
              {plugin.npmUrl}
            </button>
          </dd>
        </>
      )}
      <dt>{t('detail.plugin.field.published')}</dt>
      <dd className="num">{modified !== null ? fmtLogTime(modified) : t('detail.plugin.modifiedUnknown')}</dd>
      <dt>{t('detail.plugin.field.compat')}</dt>
      <dd className="num">
        dsh {plugin.dshPeer ?? '—'}
        {plugin.nodeEngine ? ` · node ${plugin.nodeEngine}` : ''}
      </dd>
      <dt>{t('detail.plugin.field.deps')}</dt>
      <dd>{plugin.dependencies.length > 0 ? plugin.dependencies.join(', ') : t('detail.plugin.depsNone')}</dd>
      <dt>{t('detail.plugin.field.kind')}</dt>
      <dd>{t(pluginKindKey(plugin))}</dd>
    </dl>
  )
}

/** 卸载二次确认弹窗；含 host 半时附带重启提示。 */
function RemovePluginModal(props: {
  t: Translator
  target: RemoveTarget
  onClose: () => void
  onConfirm: () => void
}): ReactNode {
  const { t, target, onClose, onConfirm } = props
  return (
    <Modal
      title={t('detail.plugin.removeConfirmTitle')}
      onClose={onClose}
      closeLabel={t('common.close')}
      testId="plugin-remove-confirm"
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-danger btn-sm" onClick={onConfirm} data-testid="plugin-remove-confirm-btn">
            {t('detail.plugin.remove')}
          </button>
        </>
      }
    >
      <p className="meta">{t('detail.plugin.removeConfirmBody', { name: target.name })}</p>
      {target.hasHostSide && (
        <p className="meta mt8" data-testid="plugin-remove-host-hint">
          {t('detail.plugin.removeHostHint')}
        </p>
      )}
    </Modal>
  )
}

/** host 半改动后的重启提醒弹窗。 */
function RestartPromptModal(props: {
  t: Translator
  name: string
  onClose: () => void
  onConfirm: () => void
}): ReactNode {
  const { t, name, onClose, onConfirm } = props
  return (
    <Modal
      title={t('detail.plugin.restartTitle')}
      onClose={onClose}
      closeLabel={t('common.close')}
      testId="plugin-restart-prompt"
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            {t('detail.plugin.restartLater')}
          </button>
          <button className="btn btn-primary btn-sm" onClick={onConfirm} data-testid="plugin-restart-now-btn">
            {t('detail.plugin.restartNow')}
          </button>
        </>
      }
    >
      <p className="meta">{t('detail.plugin.restartBody', { name })}</p>
    </Modal>
  )
}
