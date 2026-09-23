import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { DshVersionCheck, DshVersionProgressEvent } from '@shared/contracts'
import { Icon } from '../lib/icons'
import { PHASE_KEYS, REASON_KEYS } from '../lib/version-phases'
import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/**
 * 实例详情运行环境卡片中的 dsh 版本管理：手动检查更新 → 一键升级 → 进度百分比。
 * 进度经 onVersionProgress 订阅并按实例过滤，切换实例时清空本地状态。
 */
export default function DshVersionControl({ instanceId }: { instanceId: string }): ReactNode {
  const t = useAppStore((state) => state.t)
  const reloadRecord = useAppStore((state) => state.reloadRecord)
  /** 最近一次检测结果；null = 尚未检测。 */
  const [versionCheck, setVersionCheck] = useState<DshVersionCheck | null>(null)
  const [checking, setChecking] = useState(false)
  /** 检查失败的信封 message；非 null 时展示「检查失败 + 重试」。 */
  const [checkError, setCheckError] = useState<string | null>(null)
  /** 触发升级被拒绝时的信封 message。 */
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  /** 本实例的最新升级进度事件。 */
  const [progress, setProgress] = useState<DshVersionProgressEvent | null>(null)

  const active =
    progress !== null &&
    (progress.phase === 'checking' || progress.phase === 'downloading' || progress.phase === 'installing')

  useEffect(() => {
    // 切换实例时清空检测结果与进度，避免上一个实例的状态串号。
    setVersionCheck(null)
    setChecking(false)
    setCheckError(null)
    setUpgradeError(null)
    setProgress(null)
    if (!BRIDGE) return
    return BRIDGE.onVersionProgress((event) => {
      if (event.instanceId !== instanceId) return
      setProgress(event)
      // 升级完成已回写注册表：刷新详情记录，版本行立即显示新版号。
      if (event.phase === 'done') void reloadRecord(instanceId)
    })
  }, [instanceId, reloadRecord])

  /** 手动检查最新稳定版；失败保留可重试的错误提示。 */
  const runCheck = async (): Promise<void> => {
    if (checking || active) return
    setChecking(true)
    setCheckError(null)
    try {
      const result = await BRIDGE?.runtime.checkDshVersion(instanceId)
      if (!result) {
        setCheckError(t('common.unknown'))
        return
      }
      if (!result.ok) {
        setCheckError(result.message)
        return
      }
      setVersionCheck(result.value)
    } finally {
      setChecking(false)
    }
  }

  /** 触发一键升级；进展经进度事件回推，被拒绝时展示错误提示。 */
  const runUpgrade = async (): Promise<void> => {
    if (active) return
    setUpgradeError(null)
    setProgress(null)
    const result = await BRIDGE?.runtime.upgradeDshVersion(instanceId)
    if (result && !result.ok) setUpgradeError(result.message)
  }

  /** 升级失败原因：优先取进度 error，其次取触发升级的信封 message。 */
  const upgradeFail =
    progress !== null && progress.phase === 'error'
      ? (progress.error ?? t('common.unknown'))
      : upgradeError
  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)))

  const foundText =
    versionCheck !== null
      ? t('detail.version.found', {
          latest: versionCheck.latest,
          current: versionCheck.current ?? '—'
        })
      : ''

  return (
    <div className="dsh-version-control mt12" data-testid="version-manage">
      <div className="dsh-version-control__row">
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => void runCheck()}
          disabled={checking || active}
          data-testid="check-version-btn"
        >
          <Icon name="check" />
          {checking ? t('detail.version.checking') : t('detail.version.check')}
        </button>
        {/* 可升级且检测到新版才给出升级主按钮；升级中全部禁用。 */}
        {versionCheck?.canUpgrade === true && versionCheck.hasUpdate && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void runUpgrade()}
            disabled={active}
            data-testid="upgrade-btn"
          >
            <Icon name="refresh" />
            {t('detail.version.upgrade')}
          </button>
        )}
      </div>

      {/* 检测结果：可升级给新版本或已是最新；不可升级给原因，有新版时一并展示。 */}
      {versionCheck !== null && checkError === null && !active && (
        <p className="meta" data-testid="version-check-result">
          {versionCheck.canUpgrade ? (
            versionCheck.hasUpdate ? (
              foundText
            ) : (
              t('detail.version.upToDate')
            )
          ) : (
            <>
              {versionCheck.hasUpdate && <>{foundText} · </>}
              <span className="dsh-version-control__reason">
                {t(REASON_KEYS[versionCheck.reason ?? 'not-local'])}
              </span>
            </>
          )}
        </p>
      )}

      {/* 检查失败：错误 + 重试。 */}
      {checkError !== null && !active && (
        <div className="mt8" data-testid="version-check-error">
          <p className="meta err-text">{t('detail.version.checkFailed', { msg: checkError })}</p>
          <button
            className="btn btn-secondary btn-sm mt8"
            onClick={() => void runCheck()}
            data-testid="check-retry-btn"
          >
            {t('detail.version.retry')}
          </button>
        </div>
      )}

      {/* 升级中：进度条 + 阶段文字 + 百分比。 */}
      {progress !== null &&
        (progress.phase === 'checking' ||
          progress.phase === 'downloading' ||
          progress.phase === 'installing') && (
        <div className="mt8" data-testid="upgrade-progress">
          <div
            className="dsh-progress"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('detail.version.upgrade')}
          >
            <span className="dsh-progress__bar" style={{ width: `${percent}%` }} />
          </div>
          <p className="meta mt8">
            {t(PHASE_KEYS[progress.phase])} · {percent}%
            {progress.detail ? ` · ${progress.detail}` : ''}
          </p>
        </div>
      )}

      {/* 完成：阶段文字 + 新版本号（版本行同时刷新）。 */}
      {progress !== null && progress.phase === 'done' && (
        <p className="meta mt8" data-testid="upgrade-done">
          {t('detail.version.phase.done')}
          {progress.version ? ` v${progress.version}` : ''}
        </p>
      )}

      {/* 失败：错误 + 重试；隔离目录保留旧版，可直接重跑升级。 */}
      {!active && upgradeFail !== null && (
        <div className="mt8" data-testid="upgrade-error">
          <p className="meta err-text">
            {t('detail.version.upgradeFailed', { msg: upgradeFail })}
          </p>
          <button
            className="btn btn-secondary btn-sm mt8"
            onClick={() => void runUpgrade()}
            data-testid="upgrade-retry-btn"
          >
            {t('detail.version.retry')}
          </button>
        </div>
      )}
    </div>
  )
}
