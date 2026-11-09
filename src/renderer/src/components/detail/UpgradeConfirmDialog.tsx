import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PluginInstallPlan, PluginRegistryOption } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { pluginRegistryFromUrl } from '@shared/settings'
import { Icon } from '../../lib/icons'
import { Modal } from '../Modal'
import Select from '../Select'
import SectionHead from './SectionHead'
import { useAppStore } from '../../store'
import InstallConfirmPanel from './InstallConfirmPanel'
import PluginSecurityPanel from './PluginSecurityPanel'
import { REGISTRY_CHOICES, registryLabel } from './registry-choices'
import { usePluginPlanSecurity } from '../../lib/use-plugin-security-check'

const BRIDGE = window.dshHub

/** 升级执行结果：!ok 时把主进程的 message 就地显示，对话框保持打开供重试或取消。 */
export interface UpgradeOutcome {
  ok: boolean
  message?: string
}

/**
 * 升级二次确认：点「升级到 x.y.z」后先弹出，解析目标版本并展示与安装第二步同款的确认区。
 *
 * 安装源可在确认前改选：目标版本固定来自检查结果，换源只改变从哪里取该版本，改选即按新源重新解析；
 * 解析与升级必须同源，选定的档位回传给执行方。
 * 只确认目标版本与风险，不改启用态（没有「安装后启用」勾选）；
 * 真正的执行与收尾由调用方负责，失败时对话框保持打开并就地报错。
 * 开始执行后不可取消（右上角关闭按钮隐藏，Escape 与背景点击都不生效），只能「放到后台」收起确认框：
 * 升级继续在插件行执行，行内保持「升级中…」，完成或失败由调用方写入信息栏并弹提示。
 */
export default function UpgradeConfirmDialog(props: {
  t: Translator
  instanceId: string
  /** 插件名（不含版本）。 */
  name: string
  /** 目标版本（来自检查结果；升级固定走显式版本分型）。 */
  version: string
  onClose: () => void
  /** 执行升级（留痕、清检查标记、刷新列表与生效提示由调用方完成）；入参是本次选定的安装源与安全检查确认。 */
  onConfirm: (
    registry: PluginRegistryOption,
    securityAcknowledged: boolean
  ) => Promise<UpgradeOutcome>
}): ReactNode {
  const { t, instanceId, name, version, onClose, onConfirm } = props
  const closeLabel = useAppStore((state) => state.t('common.close'))
  const npmRegistry = useAppStore((state) => state.settings.npmRegistry)
  const securityEnabled = useAppStore((state) => state.settings.pluginSecurityCheck)

  // 默认安装源跟随应用设置的镜像档位：与 check 的默认源同口径（主进程同一设置推导）。
  const [registry, setRegistry] = useState<PluginRegistryOption>(() =>
    pluginRegistryFromUrl(npmRegistry)
  )
  const [plan, setPlan] = useState<PluginInstallPlan | null>(null)
  const [resolving, setResolving] = useState(true)
  const [upgrading, setUpgrading] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  const [riskAccepted, setRiskAccepted] = useState(false)
  /** 安装源小节默认展开；展开安全检查后收起，把纵向空间让给它。 */
  const [sourceOpen, setSourceOpen] = useState(true)
  /** 本确认框是否已「放到后台」：收起即失效，升级结束后的收尾据此不再碰对话框状态。 */
  const backgroundedRef = useRef(false)
  const {
    security,
    checking: securityChecking,
    blockedNow: securityBlockedNow,
    needsAcknowledgement: securityAck
  } = usePluginPlanSecurity({ instanceId, plan, registry, enabled: securityEnabled })

  useEffect(() => {
    const bridge = BRIDGE
    if (!bridge) return
    let cancelled = false
    setResolving(true)
    setResolveError(null)
    void bridge.plugin
      .resolveInstall(instanceId, `${name}@${version}`, { registry })
      .then((result) => {
        if (cancelled) return
        setResolving(false)
        if (!result.ok) {
          setResolveError(result.message)
          return
        }
        setPlan(result.value)
        // 解析出目标版本后收起安装源：来源已确定，后续看的是版本差异与安全检查。
        setSourceOpen(false)
      })
    return () => {
      cancelled = true
    }
  }, [instanceId, name, version, registry])

  /** 改选安装源：当前计划对应旧源，先作废再按新源重新解析（风险勾选与旧的失败信息一并失效）。 */
  const changeRegistry = (next: PluginRegistryOption): void => {
    if (next === registry) return
    setPlan(null)
    setRiskAccepted(false)
    setResolveError(null)
    // 上一次升级的失败原因属于旧源/旧计划：换源后重新解析，不再显示，避免与新结果并存。
    setUpgradeError(null)
    setRegistry(next)
  }

  const upgrade = async (): Promise<void> => {
    if (plan === null || upgrading) return
    // 不兼容：未勾选风险确认时不允许提交（按钮同时禁用，这里再兜一层）。
    if (plan.compatible === false && !riskAccepted) return
    if (securityChecking || securityBlockedNow) return
    setUpgrading(true)
    setUpgradeError(null)
    const result = await onConfirm(registry, securityAck)
    // 已「放到后台」：本确认框只对当前插件生效这一次，收起即失效，收尾不再执行。
    // 否则这里的 onClose() 作用的是用户此刻打开的另一个插件的确认框 —— 上一次
    // 后台升级每完成一次就关掉一个新打开的确认框，表现为「点谁的升级都被放到后台」。
    // 结果（留痕与提示）由 performUpgrade 负责，不因收起而丢失。
    if (backgroundedRef.current) return
    setUpgrading(false)
    if (!result.ok) {
      setUpgradeError(result.message ?? '')
      return
    }
    onClose()
  }

  const close = (): void => {
    // 升级执行中不可取消：Escape 与背景点击都不关闭，唯一的出口是「放到后台」。
    if (!upgrading) onClose()
  }

  /** 放到后台：只收起确认框，升级继续在插件行执行；结果由调用方留痕并提示。 */
  const background = (): void => {
    if (!upgrading) return
    backgroundedRef.current = true
    onClose()
  }

  const submitDisabled =
    resolving ||
    upgrading ||
    securityChecking ||
    securityBlockedNow ||
    plan === null ||
    (plan.compatible === false && !riskAccepted)

  return (
    <Modal
      title={t('detail.plugin.upgradeTitle')}
      onClose={close}
      closeLabel={closeLabel}
      className="modal-plugin"
      testId="upgrade-confirm-dialog"
      hideClose={upgrading}
      footer={
        <>
          <span className="meta">
            {upgrading
              ? t('detail.plugin.upgradeRunningNote')
              : t('detail.plugin.upgradeInterruptNote')}
          </span>
          <span className="right">
            {upgrading ? (
              <button
                className="btn btn-secondary btn-sm"
                onClick={background}
                data-testid="upgrade-confirm-background"
              >
                {t('detail.plugin.upgradeBackground')}
              </button>
            ) : (
              <button
                className="btn btn-secondary btn-sm"
                onClick={close}
                data-testid="upgrade-confirm-cancel"
              >
                {t('common.cancel')}
              </button>
            )}
            {securityBlockedNow ? null : (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void upgrade()}
                disabled={submitDisabled}
                data-testid="upgrade-confirm-submit"
              >
                <span className="btn-swap">
                  <span className="btn-swap-cell" data-active={!upgrading}>
                    {securityChecking
                      ? t('detail.plugin.security.checkingButton')
                      : securityAck
                        ? t('detail.plugin.security.acknowledgeUpgrade', {
                            version: plan?.targetVersion ?? version
                          })
                        : t('detail.plugin.upgradeTo', {
                            version: plan?.targetVersion ?? version
                          })}
                  </span>
                  <span className="btn-swap-cell" data-active={upgrading}>
                    {t('detail.plugin.upgrading')}
                  </span>
                </span>
              </button>
            )}
          </span>
        </>
      }
    >
      {/* 安装源在确认区之前选定：解析与升级必须同源，改选即按新源重新解析。
          收起后标题行保留当前来源，不展开也能确认本次从哪取包。 */}
      <SectionHead
        title={t('detail.plugin.installSource')}
        // 展开时选择器本身已显示来源，摘要只在收起后补位，避免同一行重复。
        aside={
          sourceOpen ? undefined : (
            <span className="section-summary">{registryLabel(t, registry)}</span>
          )
        }
        open={sourceOpen}
        onToggle={() => setSourceOpen((open) => !open)}
        testId="upgrade-confirm-source-toggle"
      />
      {sourceOpen && (
        <>
          <Select
            ariaLabel={t('detail.plugin.installSource')}
            id="upgrade-plugin-registry"
            value={registry}
            disabled={upgrading}
            onChange={(next) => changeRegistry(next as PluginRegistryOption)}
            options={REGISTRY_CHOICES.map((choice) => ({
              value: choice.value,
              label: t(choice.labelKey)
            }))}
            testId="upgrade-confirm-source"
          />

          <div className="note n-warn mt12" data-testid="upgrade-confirm-safety">
            <Icon name="alert" />
            <span>{t('detail.plugin.installSafety')}</span>
          </div>
        </>
      )}

      {resolving && <p className="meta mt12">{t('detail.plugin.installResolving')}</p>}
      {resolveError !== null && (
        <p className="meta err-text mt12" data-testid="upgrade-confirm-resolve-error">
          {t('detail.plugin.resolveFailed', { msg: resolveError })}
        </p>
      )}

      {plan !== null && (
        <>
          <InstallConfirmPanel
            t={t}
            instanceId={instanceId}
            plan={plan}
            mode="upgrade"
            registryLabel={registryLabel(t, registry)}
            riskAccepted={riskAccepted}
            onRiskChange={setRiskAccepted}
            securityPanel={
              <PluginSecurityPanel
                t={t}
                state={security.state}
                onRefresh={security.refresh}
                onExpand={() => setSourceOpen(false)}
              />
            }
          />
          <p className="meta mt8">{t('detail.plugin.upgradeKeepState')}</p>
          {upgradeError !== null && (
            <p className="meta err-text mt8" data-testid="upgrade-confirm-error">
              {t('detail.plugin.upgradeFailedInline', { msg: upgradeError })}
            </p>
          )}
        </>
      )}
    </Modal>
  )
}
