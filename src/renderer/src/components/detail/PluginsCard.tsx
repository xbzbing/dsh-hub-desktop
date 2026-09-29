import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PluginInfo } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import { Modal } from '../Modal'
import { useAppStore } from '../../store'
import {
  canOfferUpgrade,
  initialCheckState,
  pluginKindKey,
  pluginSourceKey,
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
  const setPendingOpen = useAppStore((state) => state.setPendingOpen)
  const workspaceConnected = useAppStore(
    (state) => state.workspaceConnected[instanceId] ?? false
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

  const load = useCallback(async (): Promise<void> => {
    if (!BRIDGE) return
    setLoading(true)
    setLoadError(null)
    const result = await BRIDGE.plugin.list(instanceId)
    setLoading(false)
    if (result.ok) {
      setPlugins(result.value)
      setChecks({})
    } else {
      setLoadError(result.message)
      setPlugins([])
    }
  }, [instanceId])

  useEffect(() => {
    void load()
  }, [load])

  const rowBusy = (name: string): RowBusy => busy[name] ?? { upgrading: false, removing: false }
  const setRowBusy = (name: string, patch: Partial<RowBusy>): void =>
    setBusy((prev) => ({ ...prev, [name]: { ...rowBusy(name), ...patch } }))

  const checkOf = (name: string): PluginCheckState => checks[name] ?? initialCheckState

  const runCheck = async (name: string): Promise<void> => {
    if (!BRIDGE) return
    setChecks((prev) => ({ ...prev, [name]: { status: 'checking', result: null, error: null } }))
    const result = await BRIDGE.plugin.check(instanceId, name)
    if (result.ok) {
      setChecks((prev) => ({ ...prev, [name]: { status: 'done', result: result.value, error: null } }))
    } else {
      setChecks((prev) => ({ ...prev, [name]: { status: 'error', result: null, error: result.message } }))
    }
  }

  /** 改动含 host 半时提示重启；否则提示刷新页面即可。 */
  const afterMutation = (name: string, hasHostSide: boolean): void => {
    if (hasHostSide) setRestartPrompt({ name })
    else toast('ok', t('detail.plugin.installed'), t('detail.plugin.clientOnlyHint'))
  }

  const runUpgrade = async (name: string, version: string): Promise<void> => {
    if (!BRIDGE) return
    setRowBusy(name, { upgrading: true })
    const result = await BRIDGE.plugin.upgrade(instanceId, name, version)
    setRowBusy(name, { upgrading: false })
    if (!result.ok) {
      toast('err', t('detail.plugin.upgradeFailed', { msg: result.message }))
      return
    }
    await load()
    afterMutation(name, result.value.hasHostSide)
  }

  const confirmRemove = async (): Promise<void> => {
    if (!BRIDGE || !removeTarget) return
    const { name } = removeTarget
    setRemoveTarget(null)
    setRowBusy(name, { removing: true })
    const result = await BRIDGE.plugin.remove(instanceId, name)
    setRowBusy(name, { removing: false })
    if (!result.ok) {
      toast('err', t('detail.plugin.removeFailed', { msg: result.message }))
      return
    }
    await load()
    afterMutation(name, result.value.hasHostSide)
  }

  const submitInstall = async (spec: string): Promise<void> => {
    if (!BRIDGE) return
    const result = await BRIDGE.plugin.install(instanceId, spec)
    if (!result.ok) {
      toast('err', t('detail.plugin.installFailed', { msg: result.message }))
      return
    }
    setShowInstall(false)
    await load()
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
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void load()}
            disabled={loading}
            data-testid="plugins-refresh-btn"
          >
            <Icon name="refresh" /> {t('detail.plugin.refresh')}
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
          <span className="plugin-expand-mark" aria-hidden="true">
            {expanded ? '▾' : '◂'}
          </span>
          {plugin.iconDataUri ? (
            <img className="plugin-icon" src={plugin.iconDataUri} alt="" width={20} height={20} />
          ) : (
            <span className="plugin-icon plugin-icon-fallback" aria-hidden="true">
              <Icon name="hub" size={16} />
            </span>
          )}
          <span className="plugin-name">{plugin.name}</span>
          <span className="badge num">{plugin.version}</span>
          <span className="plugin-source">{t(pluginSourceKey(plugin.installSource))}</span>
        </button>
        <div className="row plugin-actions" style={{ gap: 8 }}>
          {plugin.npmUrl && (
            <button
              className="btn btn-ghost btn-sm plugin-link"
              onClick={() => onOpenLink(plugin.npmUrl)}
              aria-label={t('detail.plugin.field.npm')}
              data-testid={`plugin-npm-${plugin.name}`}
            >
              <Icon name="link" />
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={onCheck}
            disabled={check.status === 'checking'}
            data-testid={`plugin-check-${plugin.name}`}
          >
            <Icon name="check" />
            {check.status === 'checking' ? t('detail.plugin.checking') : t('detail.plugin.checkUpdate')}
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
            className="btn btn-danger btn-sm"
            onClick={onRemove}
            disabled={busy.removing}
            data-testid={`plugin-remove-${plugin.name}`}
          >
            <Icon name="trash" />
            {busy.removing ? t('detail.plugin.removing') : t('detail.plugin.remove')}
          </button>
        </div>
      </div>

      {/* 检查结果：兼容有新版给升级按钮（上方），不兼容给警告，已最新给提示，失败给错误。 */}
      {showsUpToDate(check) && (
        <p className="meta plugin-check-result" data-testid={`plugin-uptodate-${plugin.name}`}>
          {t('detail.plugin.uptodate')}
        </p>
      )}
      {showsIncompatibleWarning(check) && check.result !== null && (
        <p className="meta err-text plugin-check-result" data-testid={`plugin-incompatible-${plugin.name}`}>
          {t('detail.plugin.incompatible', {
            latest: check.result.latest,
            peer: check.result.dshPeer ?? '—',
            current: check.result.dshVersion ?? '—'
          })}
        </p>
      )}
      {check.status === 'error' && check.error !== null && (
        <p className="meta err-text plugin-check-result" data-testid={`plugin-check-error-${plugin.name}`}>
          {t('detail.plugin.checkFailed', { msg: check.error })}
        </p>
      )}

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
      <dt>{t('detail.plugin.field.modified')}</dt>
      <dd className="num">{modified ?? t('detail.plugin.modifiedUnknown')}</dd>
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
