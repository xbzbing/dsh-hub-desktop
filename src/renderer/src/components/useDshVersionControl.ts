import { useEffect, useState } from 'react'
import type { DshVersionCheck, DshVersionProgressEvent } from '@shared/contracts'
import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/** dsh 版本管理状态：检查按钮在操作行，检测结果与进度在卡片正文，两处共用它。 */
export interface DshVersionControl {
  /** 手动检查最新稳定版；失败保留可重试的错误提示。 */
  runCheck: () => Promise<void>
  /** 触发一键升级；进展经进度事件回推，被拒绝时展示错误提示。 */
  runUpgrade: () => Promise<void>
  /** 正在检查更新。 */
  checking: boolean
  /** 检查或升级进行中，期间检查按钮禁用。 */
  active: boolean
  /** 最近一次检测结果；null = 尚未检测。 */
  versionCheck: DshVersionCheck | null
  /** 检查失败的信封 message；非 null 时展示「检查失败 + 重试」。 */
  checkError: string | null
  /** 升级失败原因：优先取进度 error，其次取触发升级的信封 message。 */
  upgradeFail: string | null
  /** 本实例的最新升级进度事件；null = 尚未开始。 */
  progress: DshVersionProgressEvent | null
}

/**
 * 实例详情运行环境卡片中的 dsh 版本管理状态：手动检查更新 → 一键升级 → 进度百分比。
 * 进度经 onVersionProgress 订阅并按实例过滤，切换实例时清空本地状态。
 * instanceId 为 null（远程实例或详情未加载）时不订阅并返回 null。
 */
export function useDshVersionControl(instanceId: string | null): DshVersionControl | null {
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
    (progress.phase === 'checking' ||
      progress.phase === 'downloading' ||
      progress.phase === 'installing')

  useEffect(() => {
    // 切换实例时清空检测结果与进度，避免上一个实例的状态串号。
    setVersionCheck(null)
    setChecking(false)
    setCheckError(null)
    setUpgradeError(null)
    setProgress(null)
    if (!instanceId || !BRIDGE) return
    return BRIDGE.onVersionProgress((event) => {
      if (event.instanceId !== instanceId) return
      setProgress(event)
      // 升级完成已回写注册表：刷新详情记录，版本行立即显示新版号。
      if (event.phase === 'done') void reloadRecord(instanceId)
    })
  }, [instanceId, reloadRecord])

  /** 手动检查最新稳定版；失败保留可重试的错误提示。 */
  const runCheck = async (): Promise<void> => {
    if (instanceId === null || checking || active) return
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
    if (instanceId === null || active) return
    setUpgradeError(null)
    setProgress(null)
    const result = await BRIDGE?.runtime.upgradeDshVersion(instanceId)
    if (result && !result.ok) setUpgradeError(result.message)
  }

  if (instanceId === null) return null
  return {
    runCheck,
    runUpgrade,
    checking,
    active,
    versionCheck,
    checkError,
    upgradeFail:
      progress !== null && progress.phase === 'error'
        ? (progress.error ?? t('common.unknown'))
        : upgradeError,
    progress
  }
}
