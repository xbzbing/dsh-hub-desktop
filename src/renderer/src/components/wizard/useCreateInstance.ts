import { useCallback } from 'react'
import { useAppStore } from '../../store'
import { buildCreateInput } from './build-input'
import { validateWizardForm } from './validate'
import type { ExternalWorkspace, WizardForm, WizardTransport } from './types'

export interface UseCreateInstanceArgs {
  transport: WizardTransport
  form: WizardForm
  useExistingExternal: boolean
  externalWorkspace: ExternalWorkspace | null
  /** 检测到的可复用外部实例（已在注册表中）；存在时走接管而非新建。 */
  reusableExternalInstanceId: string | null
  existingSpaceId: string | null
  setBusy: (value: boolean) => void
  setError: (value: string | null) => void
  setStep: (value: number) => void
}

export interface UseCreateInstanceResult {
  /** 第 2 步表单校验：返回首个错误文案，null 表示通过。 */
  validate: () => string | null
  /** 提交创建（或接管外部实例）：编排 IPC、提示、导航与启动。 */
  submit: () => Promise<void>
}

/**
 * 向导创建编排：把校验、构造入参、接管/新建、创建后导航与自动启动收进一个 hook，
 * 让 Wizard 组件只负责渲染与本地 UI 状态。
 */
export function useCreateInstance(args: UseCreateInstanceArgs): UseCreateInstanceResult {
  const {
    transport,
    form,
    useExistingExternal,
    externalWorkspace,
    reusableExternalInstanceId,
    existingSpaceId,
    setBusy,
    setError,
    setStep
  } = args
  const t = useAppStore((state) => state.t)
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  const refreshList = useAppStore((state) => state.refreshList)
  const openWorkspace = useAppStore((state) => state.openWorkspace)
  const select = useAppStore((state) => state.select)
  const setPendingOpen = useAppStore((state) => state.setPendingOpen)
  const toast = useAppStore((state) => state.toast)

  const validate = useCallback(
    () =>
      validateWizardForm({
        t,
        transport,
        form,
        useExistingExternal,
        hasReusableExternal: reusableExternalInstanceId !== null
      }),
    [t, transport, form, useExistingExternal, reusableExternalInstanceId]
  )

  const submit = useCallback(async () => {
    const bridge = window.dshHub
    if (!bridge) return
    const name = form.name.trim()

    // 已有可复用外部实例：走接管而非新建。
    if (reusableExternalInstanceId !== null) {
      setBusy(true)
      setError(null)
      try {
        if (!externalWorkspace) {
          setError(t('wizard.errExternalAccess'))
          return
        }
        const adopted = await bridge.runtime.adoptExternal(
          reusableExternalInstanceId,
          externalWorkspace.pid,
          form.externalAccess.trim()
        )
        if (!adopted.ok) {
          setError(adopted.message)
          return
        }
        setWizardOpen(false)
        void openWorkspace(reusableExternalInstanceId)
        return
      } finally {
        setBusy(false)
      }
    }

    const problem = validate()
    if (problem) {
      setError(problem)
      setStep(2)
      return
    }

    const input = buildCreateInput({
      transport,
      form,
      name,
      useExistingExternal,
      externalWorkspace,
      existingSpaceId
    })

    setBusy(true)
    setError(null)
    const result = await bridge.instances.create(input).finally(() => setBusy(false))
    if (!result.ok) {
      setError(result.message)
      setStep(2)
      return
    }
    setWizardOpen(false)
    toast('ok', t('wizard.created', { name: result.value.name }))
    void refreshList()
    // 创建后无论启动成功与否都先落到详情；失败时用户可立即编辑端口、配置档案或启动器。
    select(result.value.id)
    if (transport === 'local' && useExistingExternal) {
      void openWorkspace(result.value.id)
      return
    }
    // 启动成功后由状态事件打开工作区；失败或停止时移除待打开记录。
    setPendingOpen(result.value.id)
    const started = await bridge.runtime.start(result.value.id)
    if (!started.ok) {
      toast('err', t('wizard.startFailed'), started.message)
      // 失败事件会在 applyStatus 里把该 id 移出待开集合
    }
  }, [
    t,
    transport,
    form,
    useExistingExternal,
    externalWorkspace,
    reusableExternalInstanceId,
    existingSpaceId,
    validate,
    setBusy,
    setError,
    setStep,
    setWizardOpen,
    refreshList,
    openWorkspace,
    select,
    setPendingOpen,
    toast
  ])

  return { validate, submit }
}
